//! SQLite storage. The connection lives on one dedicated thread; async callers send closures
//! over a channel and await the result through a oneshot, so the UI never blocks on disk I/O.

mod migrations;
mod repo;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::thread::JoinHandle;

use crossbeam_channel::Sender;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use crate::error::{CoreError, ErrorKind};
use crate::settings::Settings;

pub use migrations::SCHEMA_VERSION;
pub use repo::{clamp_history_limit, MAX_HISTORY_LIMIT, MIN_HISTORY_LIMIT};

impl From<rusqlite::Error> for CoreError {
    fn from(err: rusqlite::Error) -> Self {
        CoreError::new(ErrorKind::Io, err.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(err: serde_json::Error) -> Self {
        CoreError::new(ErrorKind::Other, err.to_string())
    }
}

/// Everything the frontend needs to hydrate on start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub collections: Vec<Value>,
    pub environments: Vec<Value>,
    pub globals: Value,
    pub active_env_id: Option<String>,
    /// Newest first, capped to the stored history limit.
    pub history: Vec<Value>,
    pub tabs: Vec<Value>,
    pub ui_state: Map<String, Value>,
    pub cookies_json: Option<String>,
    pub settings: Settings,
}

/// One per-entity write. `json` payloads are opaque JSON strings produced by the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum EntityOp {
    UpsertCollection {
        id: String,
        sort: i64,
        json: String,
    },
    DeleteCollection {
        id: String,
    },
    UpsertEnvironment {
        id: String,
        sort: i64,
        json: String,
    },
    DeleteEnvironment {
        id: String,
    },
    SetGlobals {
        json: String,
    },
    SetActiveEnv {
        id: Option<String>,
    },
    /// `(tab id, tab json)` in display order; replaces all tabs.
    ReplaceTabs {
        tabs: Vec<(String, String)>,
    },
    SetUiState {
        key: String,
        json: String,
    },
    SetCookies {
        json: String,
    },
    SetSettings {
        json: String,
    },
    ClearHistory,
    DeleteHistory {
        id: String,
    },
}

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

pub struct Db {
    tx: Option<Sender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, CoreError> {
        Self::spawn(migrations::open_file(path)?)
    }

    pub fn open_in_memory() -> Result<Db, CoreError> {
        let mut conn = Connection::open_in_memory()?;
        migrations::apply_pragmas(&conn)?;
        migrations::migrate(&mut conn)?;
        Self::spawn(conn)
    }

    fn spawn(mut conn: Connection) -> Result<Db, CoreError> {
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        let thread = std::thread::Builder::new()
            .name("vectis-db".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    job(&mut conn);
                }
            })?;
        Ok(Db {
            tx: Some(tx),
            thread: Some(thread),
        })
    }

    async fn run<T, F>(&self, f: F) -> Result<T, CoreError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, CoreError> + Send + 'static,
    {
        let (otx, orx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let result = catch_unwind(AssertUnwindSafe(|| f(conn)))
                .unwrap_or_else(|_| Err(CoreError::new(ErrorKind::Other, "database job panicked")));
            let _ = otx.send(result);
        });
        let closed = || CoreError::new(ErrorKind::Other, "database thread is not running");
        self.tx
            .as_ref()
            .ok_or_else(closed)?
            .send(job)
            .map_err(|_| closed())?;
        orx.await.map_err(|_| closed())?
    }

    pub async fn load_workspace(&self) -> Result<WorkspaceSnapshot, CoreError> {
        self.run(|c| repo::load_workspace(c)).await
    }

    /// Applies all ops in one transaction; any failure leaves the database unchanged.
    pub async fn save_entities(&self, ops: Vec<EntityOp>) -> Result<(), CoreError> {
        self.run(move |c| repo::save_entities(c, ops)).await
    }

    /// Adds a history entry (one per method+URL; a repeat replaces the old one and moves to top),
    /// then prunes to the `limit` newest.
    #[allow(clippy::too_many_arguments)]
    pub async fn add_history(
        &self,
        item_json: String,
        method: String,
        url: String,
        status: u16,
        duration_ms: f64,
        ts: i64,
        limit: u32,
    ) -> Result<(), CoreError> {
        self.run(move |c| {
            repo::add_history(c, &item_json, &method, &url, status, duration_ms, ts, limit)
        })
        .await
    }

    /// Newest-first prefix search over method and URL; an empty query lists the newest items.
    pub async fn search_history(&self, q: String, limit: u32) -> Result<Vec<String>, CoreError> {
        self.run(move |c| repo::search_history(c, &q, limit)).await
    }

    pub async fn export_backup(&self) -> Result<String, CoreError> {
        self.run(|c| repo::export_backup(c)).await
    }

    /// Replaces all workspace data (cookies excluded) in one transaction.
    pub async fn import_backup(&self, json: String) -> Result<(), CoreError> {
        self.run(move |c| repo::import_backup(c, &json)).await
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
