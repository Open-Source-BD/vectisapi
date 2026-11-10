//! Serializable core error: `{ kind, message }` at the IPC boundary.

use std::error::Error as StdError;
use std::io;

use serde::{Deserialize, Serialize};

/// Error category shown in the response pane. Serializes snake_case (`"connection_refused"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    InvalidUrl,
    ConnectionRefused,
    Dns,
    Timeout,
    ConnectionReset,
    Tls,
    Cancelled,
    BodyTooLarge,
    Io,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct CoreError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CoreError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<io::Error> for CoreError {
    fn from(err: io::Error) -> Self {
        Self::new(ErrorKind::Io, err.to_string())
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(err: reqwest::Error) -> Self {
        let kind = classify(&err);
        Self::new(kind, chain_message(&err))
    }
}

/// Maps a reqwest error to a kind by inspecting it and its source chain.
fn classify(err: &reqwest::Error) -> ErrorKind {
    if err.is_timeout() {
        return ErrorKind::Timeout;
    }
    if err.is_dns() {
        return ErrorKind::Dns;
    }
    let mut source: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = source {
        if e.is::<rustls::Error>() {
            return ErrorKind::Tls;
        }
        source = e.source();
        if let Some(io_err) = e.downcast_ref::<io::Error>() {
            match io_err.kind() {
                io::ErrorKind::ConnectionRefused => return ErrorKind::ConnectionRefused,
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted => {
                    return ErrorKind::ConnectionReset
                }
                io::ErrorKind::TimedOut => return ErrorKind::Timeout,
                _ => {}
            }
            // io::Error::source() skips the error it wraps (often another io::Error or a
            // rustls::Error), so descend into the wrapped error itself.
            if let Some(inner) = io_err.get_ref() {
                source = Some(inner as &(dyn StdError + 'static));
            }
        }
    }
    ErrorKind::Other
}

/// "outer: inner: innermost" — reqwest's own Display omits the cause.
fn chain_message(err: &reqwest::Error) -> String {
    let mut parts: Vec<String> = vec![err.to_string()];
    let mut source = err.source();
    while let Some(e) = source {
        let text = e.to_string();
        if parts.last() != Some(&text) {
            parts.push(text);
        }
        source = e.source();
    }
    parts.join(": ")
}
