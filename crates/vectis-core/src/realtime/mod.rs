//! Realtime connections (WebSocket and Server-Sent Events) keyed by a caller-chosen id.
//!
//! Each connection runs on its own tokio task and reports [`RtEvent`]s to a sink. Every
//! connection that started (`Connecting`) ends with exactly one terminal event, `Closed` or
//! `Error`; after [`RtRegistry::close`] returns, the sink is never called again for it.
//!
//! Sinks must be quick and must not call back into the registry (the sink runs under the
//! connection's delivery lock). A panicking sink ends its connection silently; with the release
//! profile's `panic = "abort"` that cannot be caught, so sinks should swallow their own errors.

mod sse;
mod ws;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::cookies::CookieJar;
use crate::error::{CoreError, ErrorKind};
use crate::http::{ClientPool, HttpRequestSpec};

pub use sse::{SseFrame, SseParser};

/// Reason of the final `Closed` event emitted by [`RtRegistry::close`].
const CLOSED_BY_USER: &str = "closed by user";

/// An event on a realtime connection, sent to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RtEvent {
    Connecting,
    Open,
    /// A WebSocket frame. Binary frames carry `[binary N bytes]` as text.
    Message {
        text: String,
        bytes: u64,
        binary: bool,
    },
    SseEvent {
        event: String,
        data: String,
        id: Option<String>,
    },
    /// WebSocket close code (`None` for SSE) and reason.
    Closed {
        code: Option<u16>,
        reason: String,
    },
    Error {
        message: String,
    },
}

type Sink = Box<dyn Fn(RtEvent) + Send + Sync>;

/// Delivers a connection's events and enforces "nothing after the terminal event".
struct Emitter {
    /// False once a terminal event was delivered, the connection was closed, or the sink failed.
    /// Held while the sink runs so `close()` cannot interleave with a delivery.
    alive: Mutex<bool>,
    sink: Sink,
    cancel: CancellationToken,
}

impl Emitter {
    /// Delivers a non-terminal event. Returns false when the connection is finished.
    fn emit(&self, event: RtEvent) -> bool {
        let mut alive = self.alive.lock();
        if !*alive {
            return false;
        }
        if !self.deliver(event) {
            *alive = false;
            self.cancel.cancel();
        }
        *alive
    }

    /// Delivers the terminal event (unless one was already delivered) and stops the task.
    fn finish(&self, event: RtEvent) {
        let mut alive = self.alive.lock();
        if *alive {
            *alive = false;
            self.deliver(event);
        }
        drop(alive);
        self.cancel.cancel();
    }

    /// Stops the task without emitting anything.
    fn abandon(&self) {
        *self.alive.lock() = false;
        self.cancel.cancel();
    }

    /// Calls the sink; a panicking sink counts as failed and ends the connection.
    fn deliver(&self, event: RtEvent) -> bool {
        catch_unwind(AssertUnwindSafe(|| (self.sink)(event))).is_ok()
    }
}

enum ConnKind {
    Ws {
        outgoing: mpsc::UnboundedSender<String>,
        /// Set once the handshake completed; sends before that are refused.
        open: Arc<AtomicBool>,
    },
    Sse,
}

struct Conn {
    generation: u64,
    emitter: Arc<Emitter>,
    kind: ConnKind,
}

type Conns = Arc<DashMap<String, Conn>>;

/// Handle a connection task uses to emit events and to unregister itself when it ends.
pub(crate) struct ConnTask {
    conns: Conns,
    conn_id: String,
    generation: u64,
    emitter: Arc<Emitter>,
}

impl ConnTask {
    fn cancelled(&self) -> tokio_util::sync::WaitForCancellationFuture<'_> {
        self.emitter.cancel.cancelled()
    }

    fn emit(&self, event: RtEvent) -> bool {
        self.emitter.emit(event)
    }

    /// Unregisters the connection, then emits its terminal event (if `close()` has not).
    /// Unregistering first lets the UI reopen the same id as soon as it sees the event.
    fn end(self, event: RtEvent) {
        self.unregister();
        self.emitter.finish(event);
    }

    fn unregister(&self) {
        self.conns
            .remove_if(&self.conn_id, |_, c| c.generation == self.generation);
    }
}

impl Drop for ConnTask {
    /// Covers tasks that stop without `end` (e.g. cancelled by `close`).
    fn drop(&mut self) {
        self.unregister();
    }
}

/// Owns all live realtime connections.
pub struct RtRegistry {
    jar: Arc<CookieJar>,
    pool: ClientPool,
    conns: Conns,
    next_generation: AtomicU64,
}

impl RtRegistry {
    pub fn new(jar: Arc<CookieJar>, pool: ClientPool) -> Self {
        Self {
            jar,
            pool,
            conns: Arc::new(DashMap::new()),
            next_generation: AtomicU64::new(0),
        }
    }

    /// Opens a WebSocket (`ws`, `wss`; `http(s)` is mapped to `ws(s)`). Returns once the
    /// connection task is started; progress arrives as events. A no-op if `conn_id` is open.
    /// Invalid URLs or headers fail here, before any event.
    pub async fn open_ws(
        &self,
        conn_id: String,
        url: String,
        headers: Vec<(String, String)>,
        protocols: Vec<String>,
        sink: impl Fn(RtEvent) + Send + Sync + 'static,
    ) -> Result<(), CoreError> {
        if self.conns.contains_key(&conn_id) {
            return Ok(());
        }
        let request = ws::build_request(&url, &headers, &protocols, &self.jar)?;
        let open = Arc::new(AtomicBool::new(false));
        let (outgoing, rx) = mpsc::unbounded_channel();
        let kind = ConnKind::Ws {
            outgoing,
            open: open.clone(),
        };
        let Some(task) = self.register(conn_id, kind, Box::new(sink)) else {
            return Ok(());
        };
        let params = ws::WsParams {
            request,
            verify_tls: self.pool.verify_tls(),
            connect_timeout_ms: self.pool.timeout_ms(),
            jar: self.jar.clone(),
            open,
            outgoing: rx,
        };
        tokio::spawn(ws::run(task, params));
        Ok(())
    }

    /// Queues a text frame. Fails if the connection is not an open WebSocket.
    pub async fn send_ws(&self, conn_id: &str, text: String) -> Result<(), CoreError> {
        let not_open = || CoreError::new(ErrorKind::Other, "WebSocket is not open");
        let conn = self.conns.get(conn_id).ok_or_else(not_open)?;
        match &conn.kind {
            ConnKind::Ws { outgoing, open } if open.load(Ordering::Acquire) => {
                outgoing.send(text).map_err(|_| not_open())
            }
            _ => Err(not_open()),
        }
    }

    /// Opens an SSE stream with the shared HTTP client (proxy/TLS settings apply). Returns once
    /// the stream task is started. A no-op if `conn_id` is open. Never reconnects by itself.
    pub async fn open_sse(
        &self,
        conn_id: String,
        spec: HttpRequestSpec,
        last_event_id: Option<String>,
        sink: impl Fn(RtEvent) + Send + Sync + 'static,
    ) -> Result<(), CoreError> {
        if self.conns.contains_key(&conn_id) {
            return Ok(());
        }
        let request = sse::prepare(&spec, last_event_id.as_deref(), &self.pool)?;
        let Some(task) = self.register(conn_id, ConnKind::Sse, Box::new(sink)) else {
            return Ok(());
        };
        tokio::spawn(sse::run(task, request, self.pool.clone(), self.jar.clone()));
        Ok(())
    }

    /// Closes a connection. Emits a final `Closed` ("closed by user"; code 1000 for WebSocket)
    /// unless the connection already ended; no event follows. Unknown ids are ignored.
    pub fn close(&self, conn_id: &str) {
        if let Some((_, conn)) = self.conns.remove(conn_id) {
            let code = matches!(conn.kind, ConnKind::Ws { .. }).then_some(1000);
            conn.emitter.finish(RtEvent::Closed {
                code,
                reason: CLOSED_BY_USER.to_string(),
            });
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.conns.iter().map(|c| c.key().clone()).collect();
        for id in ids {
            self.close(&id);
        }
    }

    /// Inserts the connection unless the id is taken, then emits `Connecting`.
    fn register(&self, conn_id: String, kind: ConnKind, sink: Sink) -> Option<ConnTask> {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let emitter = Arc::new(Emitter {
            alive: Mutex::new(true),
            sink,
            cancel: CancellationToken::new(),
        });
        match self.conns.entry(conn_id.clone()) {
            Entry::Occupied(_) => return None,
            Entry::Vacant(slot) => {
                slot.insert(Conn {
                    generation,
                    emitter: emitter.clone(),
                    kind,
                });
            }
        }
        // The map shard lock is released before the sink runs.
        emitter.emit(RtEvent::Connecting);
        Some(ConnTask {
            conns: self.conns.clone(),
            conn_id,
            generation,
            emitter,
        })
    }
}

impl Drop for RtRegistry {
    /// Stops every connection task silently.
    fn drop(&mut self) {
        for conn in self.conns.iter() {
            conn.emitter.abandon();
        }
    }
}
