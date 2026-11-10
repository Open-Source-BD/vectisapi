//! Serializable request/response types that cross IPC to the TypeScript UI.

use serde::{Deserialize, Serialize};

/// A fully resolved request (env vars, auth and scripts already applied in TS).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestSpec {
    pub request_id: String,
    pub method: String,
    pub url: String,
    /// Sent in order; duplicate names are kept.
    pub headers: Vec<(String, String)>,
    pub body: BodySpec,
    /// Overrides the settings timeout; `Some(0)` means no timeout.
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum BodySpec {
    None,
    Text(String),
    /// Raw bytes, base64-encoded.
    Base64(String),
    UrlEncoded(Vec<(String, String)>),
    Multipart(Vec<MultipartPart>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPart {
    pub name: String,
    pub value: PartValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PartValue {
    Text(String),
    /// Streamed from disk at send time. `file_name` defaults to the path's file name.
    File {
        path: String,
        file_name: Option<String>,
        content_type: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub total_ms: f64,
    /// Time until response headers arrived.
    pub ttfb_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    /// Key into the `ResponseStore` for the full body.
    pub response_id: String,
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    /// In wire order; duplicate names are kept.
    pub headers: Vec<(String, String)>,
    pub remote_addr: Option<String>,
    pub final_url: String,
    /// Decoded body length in bytes.
    pub size: u64,
    pub timing: Timing,
    /// True when the inline body is only the first `INLINE_PREFIX_BYTES`.
    pub truncated: bool,
}
