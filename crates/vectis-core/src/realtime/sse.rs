//! Server-Sent Events: an incremental byte-level parser (WHATWG event-stream, ported from
//! next-postman's `parseSse.ts`) and the stream task built on the shared reqwest client.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, COOKIE, SET_COOKIE};
use reqwest::Method;
use url::Url;

use super::{ConnTask, RtEvent};
use crate::cookies::CookieJar;
use crate::error::{CoreError, ErrorKind};
use crate::http::{
    attach_body, build_headers, parse_url, redirect_target, strip_on_hop, BodySpec, ClientPool,
    HttpRequestSpec,
};
use std::sync::Arc;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// One dispatched event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    /// `message` unless the stream set `event:`.
    pub event: String,
    /// `data:` lines joined with `\n`.
    pub data: String,
    /// The last event id seen on the stream so far (ids persist across events).
    pub id: Option<String>,
    /// `retry:` milliseconds, if given in this event.
    pub retry: Option<u64>,
}

/// Incremental parser. Feed raw bytes as they arrive; whole events come out. Lines are split on
/// bytes (CR, LF and CRLF, also when a CRLF straddles two chunks) and decoded only once complete,
/// so UTF-8 sequences split across chunks survive. A UTF-8 BOM at stream start is skipped.
#[derive(Debug, Default)]
pub struct SseParser {
    line: Vec<u8>,
    /// The previous chunk ended with CR; a leading LF in the next chunk belongs to it.
    after_cr: bool,
    seen_first_line: bool,
    data: Option<String>,
    event: String,
    retry: Option<u64>,
    last_id: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// The id to send as `Last-Event-ID` when reconnecting.
    pub fn last_id(&self) -> Option<&str> {
        self.last_id.as_deref()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseFrame> {
        let mut out = Vec::new();
        let mut rest = chunk;
        if self.after_cr && !rest.is_empty() {
            self.after_cr = false;
            if rest[0] == b'\n' {
                rest = &rest[1..];
            }
        }
        while let Some(i) = rest.iter().position(|&b| b == b'\r' || b == b'\n') {
            self.line.extend_from_slice(&rest[..i]);
            let was_cr = rest[i] == b'\r';
            rest = &rest[i + 1..];
            self.end_line(&mut out);
            if was_cr {
                match rest.first() {
                    Some(b'\n') => rest = &rest[1..],
                    Some(_) => {}
                    None => self.after_cr = true,
                }
            }
        }
        self.line.extend_from_slice(rest);
        out
    }

    fn end_line(&mut self, out: &mut Vec<SseFrame>) {
        let mut bytes: &[u8] = &self.line;
        if !self.seen_first_line {
            self.seen_first_line = true;
            bytes = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
        }
        let line = String::from_utf8_lossy(bytes).into_owned();
        self.line.clear();
        self.process_line(&line, out);
    }

    fn process_line(&mut self, line: &str, out: &mut Vec<SseFrame>) {
        if line.is_empty() {
            // A blank line dispatches the event, but only if data was collected.
            if let Some(data) = self.data.take() {
                let event = std::mem::take(&mut self.event);
                out.push(SseFrame {
                    event: if event.is_empty() {
                        "message".to_string()
                    } else {
                        event
                    },
                    data,
                    id: self.last_id.clone(),
                    retry: self.retry,
                });
            }
            self.event.clear();
            self.retry = None;
            return;
        }
        if line.starts_with(':') {
            return; // comment / heartbeat
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            "event" => self.event = value.to_string(),
            "id" if !value.contains('\0') => self.last_id = Some(value.to_string()),
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                self.retry = value.parse().ok();
            }
            _ => {}
        }
    }
}

/// A validated SSE request, ready to send.
pub(super) struct SseRequest {
    url: Url,
    method: Method,
    headers: HeaderMap,
    body: BodySpec,
    /// Bounds each hop until response headers arrive; `0` = none. The stream itself is unbounded.
    connect_timeout_ms: u64,
}

/// Checks the spec up front so bad input fails the open call instead of the stream.
pub(super) fn prepare(
    spec: &HttpRequestSpec,
    last_event_id: Option<&str>,
    pool: &ClientPool,
) -> Result<SseRequest, CoreError> {
    pool.check()?;
    let url = parse_url(&spec.url)?;
    let method =
        Method::from_bytes(spec.method.trim().to_ascii_uppercase().as_bytes()).map_err(|_| {
            CoreError::new(ErrorKind::Other, format!("invalid method: {}", spec.method))
        })?;
    let is_multipart = matches!(spec.body, BodySpec::Multipart(_));
    let mut headers = build_headers(&spec.headers, is_multipart)?;
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    if let Some(id) = last_event_id {
        let value = HeaderValue::from_str(id)
            .map_err(|_| CoreError::new(ErrorKind::Other, "invalid Last-Event-ID"))?;
        headers.insert("last-event-id", value);
    }
    Ok(SseRequest {
        url,
        method,
        headers,
        body: spec.body.clone(),
        connect_timeout_ms: spec.timeout_ms.unwrap_or_else(|| pool.timeout_ms()),
    })
}

pub(super) async fn run(
    task: ConnTask,
    request: SseRequest,
    pool: ClientPool,
    jar: Arc<CookieJar>,
) {
    let response = tokio::select! {
        () = task.cancelled() => return,
        r = connect(request, &pool, &jar) => r,
    };
    let response = match response {
        Ok(r) => r,
        Err(message) => return task.end(RtEvent::Error { message }),
    };
    let status = response.status();
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("");
        return task.end(RtEvent::Error {
            message: format!("Upstream responded {} {reason}", status.as_u16()),
        });
    }
    if !task.emit(RtEvent::Open) {
        return;
    }

    let mut parser = SseParser::new();
    let mut stream = response.bytes_stream();
    let terminal = loop {
        let chunk = tokio::select! {
            () = task.cancelled() => return,
            chunk = stream.next() => chunk,
        };
        match chunk {
            Some(Ok(bytes)) => {
                for frame in parser.push(&bytes) {
                    let event = RtEvent::SseEvent {
                        event: frame.event,
                        data: frame.data,
                        id: frame.id,
                    };
                    if !task.emit(event) {
                        return;
                    }
                }
            }
            Some(Err(e)) => {
                break RtEvent::Error {
                    message: CoreError::from(e).message,
                }
            }
            None => {
                break RtEvent::Closed {
                    code: None,
                    reason: "stream ended".to_string(),
                }
            }
        }
    };
    task.end(terminal);
}

/// Sends the request, following redirects like the HTTP engine (jar per hop, Set-Cookie stored
/// per hop, 301–303 turn into a body-less GET). Returns the final response.
async fn connect(
    request: SseRequest,
    pool: &ClientPool,
    jar: &CookieJar,
) -> Result<reqwest::Response, String> {
    let SseRequest {
        mut url,
        mut method,
        mut headers,
        mut body,
        connect_timeout_ms,
    } = request;
    let client = pool.client();
    let use_jar = !headers.contains_key(COOKIE);
    let mut redirects = 0;
    loop {
        let mut hop_headers = headers.clone();
        if use_jar {
            if let Some(cookie) = jar.header_for(&url) {
                if let Ok(value) = HeaderValue::from_str(&cookie) {
                    hop_headers.append(COOKIE, value);
                }
            }
        }
        let has_content_type = hop_headers.contains_key(reqwest::header::CONTENT_TYPE);
        let builder = client
            .request(method.clone(), url.clone())
            .headers(hop_headers);
        let builder = attach_body(builder, &body, has_content_type)
            .await
            .map_err(|e| e.message)?;
        let send = builder.send();
        let response = if connect_timeout_ms == 0 {
            send.await
        } else {
            tokio::time::timeout(Duration::from_millis(connect_timeout_ms), send)
                .await
                .map_err(|_| "request timed out".to_string())?
        }
        .map_err(|e| CoreError::from(e).message)?;

        let set_cookies: Vec<String> = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect();
        if !set_cookies.is_empty() {
            jar.store_response(&url, &set_cookies);
        }

        let Some(max) = pool.max_redirects() else {
            return Ok(response);
        };
        let Some(next) = redirect_target(&response, &url) else {
            return Ok(response);
        };
        if redirects >= max {
            return Err(format!("too many redirects (max {max})"));
        }
        redirects += 1;
        strip_on_hop(&url, &next, &mut headers);
        if matches!(response.status().as_u16(), 301..=303)
            && method != Method::GET
            && method != Method::HEAD
        {
            method = Method::GET;
            body = BodySpec::None;
            for name in [
                reqwest::header::CONTENT_TYPE,
                reqwest::header::CONTENT_LENGTH,
                reqwest::header::CONTENT_ENCODING,
                reqwest::header::TRANSFER_ENCODING,
            ] {
                headers.remove(name);
            }
        }
        url = next;
    }
}
