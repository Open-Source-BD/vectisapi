//! Sends an `HttpRequestSpec`, streams the body into the `ResponseStore`, supports cancellation.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::{Bytes, BytesMut};
use dashmap::DashMap;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, COOKIE, SET_COOKIE};
use reqwest::multipart::{Form, Part};
use reqwest::{Method, RequestBuilder, Version};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::client::ClientPool;
use super::spec::{BodySpec, HttpRequestSpec, MultipartPart, PartValue, ResponseMeta, Timing};
use super::store::{ResponseStore, INLINE_PREFIX_BYTES};
use crate::cookies::CookieJar;
use crate::error::{CoreError, ErrorKind};

pub struct HttpEngine {
    pool: ClientPool,
    store: Arc<ResponseStore>,
    jar: Arc<CookieJar>,
    /// request id → (send generation, token). The generation keeps a reused id's
    /// finished send from unregistering a newer one.
    inflight: DashMap<String, (u64, CancellationToken)>,
    next_generation: AtomicU64,
}

impl HttpEngine {
    pub fn new(pool: ClientPool, store: Arc<ResponseStore>, jar: Arc<CookieJar>) -> Self {
        Self {
            pool,
            store,
            jar,
            inflight: DashMap::new(),
            next_generation: AtomicU64::new(0),
        }
    }

    /// Sends the request. Returns metadata and the first `INLINE_PREFIX_BYTES` of the body;
    /// the full body is in the `ResponseStore` under `meta.response_id`.
    pub async fn send(&self, spec: HttpRequestSpec) -> Result<(ResponseMeta, Bytes), CoreError> {
        let token = CancellationToken::new();
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        self.inflight
            .insert(spec.request_id.clone(), (generation, token.clone()));
        let _registration = Registration {
            inflight: &self.inflight,
            request_id: &spec.request_id,
            generation,
        };
        tokio::select! {
            biased;
            () = token.cancelled() => Err(CoreError::new(ErrorKind::Cancelled, "request cancelled")),
            result = self.execute(&spec) => result,
        }
    }

    /// Cancels an in-flight request. Returns false if no such request is running.
    pub fn cancel(&self, request_id: &str) -> bool {
        match self.inflight.get(request_id) {
            Some(entry) => {
                entry.1.cancel();
                true
            }
            None => false,
        }
    }

    async fn execute(&self, spec: &HttpRequestSpec) -> Result<(ResponseMeta, Bytes), CoreError> {
        self.pool.check()?;
        let url = parse_url(&spec.url)?;
        let method = Method::from_bytes(spec.method.trim().to_ascii_uppercase().as_bytes())
            .map_err(|_| {
                CoreError::new(ErrorKind::Other, format!("invalid method: {}", spec.method))
            })?;
        let is_multipart = matches!(spec.body, BodySpec::Multipart(_));
        let mut headers = build_headers(&spec.headers, is_multipart)?;
        if !headers.contains_key(COOKIE) {
            if let Some(cookie) = self.jar.header_for(&url) {
                if let Ok(value) = HeaderValue::from_str(&cookie) {
                    headers.append(COOKIE, value);
                }
            }
        }

        let has_content_type = headers.contains_key(CONTENT_TYPE);
        let mut request = self.pool.client().request(method, url).headers(headers);
        let timeout_ms = spec.timeout_ms.unwrap_or_else(|| self.pool.timeout_ms());
        if timeout_ms > 0 {
            request = request.timeout(Duration::from_millis(timeout_ms));
        }
        request = attach_body(request, &spec.body, has_content_type).await?;

        let started = Instant::now();
        let response = request.send().await?;
        let ttfb_ms = elapsed_ms(started);

        let status = response.status();
        let final_url = response.url().clone();
        let response_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_string(),
                    String::from_utf8_lossy(v.as_bytes()).into_owned(),
                )
            })
            .collect();
        let set_cookies: Vec<String> = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .collect();
        let http_version = version_label(response.version());
        let remote_addr = response.remote_addr().map(|a| a.to_string());
        if !set_cookies.is_empty() {
            self.jar.store_response(&final_url, &set_cookies);
        }

        let response_id = uuid::Uuid::new_v4().to_string();
        let mut writer = self.store.begin(&response_id);
        let mut prefix = BytesMut::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if prefix.len() < INLINE_PREFIX_BYTES {
                let take = chunk.len().min(INLINE_PREFIX_BYTES - prefix.len());
                prefix.extend_from_slice(&chunk[..take]);
            }
            writer.push(chunk)?;
        }
        let size = writer.finish();
        let total_ms = elapsed_ms(started);

        let meta = ResponseMeta {
            response_id,
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            http_version,
            headers: response_headers,
            remote_addr,
            final_url: final_url.to_string(),
            size,
            timing: Timing { total_ms, ttfb_ms },
            truncated: size > INLINE_PREFIX_BYTES as u64,
        };
        Ok((meta, prefix.freeze()))
    }
}

/// Unregisters a send's cancellation token when the send finishes (or is dropped).
struct Registration<'a> {
    inflight: &'a DashMap<String, (u64, CancellationToken)>,
    request_id: &'a str,
    generation: u64,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.inflight
            .remove_if(self.request_id, |_, (generation, _)| {
                *generation == self.generation
            });
    }
}

fn parse_url(raw: &str) -> Result<Url, CoreError> {
    let invalid = |reason: &str| {
        CoreError::new(
            ErrorKind::InvalidUrl,
            format!("invalid URL \"{raw}\": {reason}"),
        )
    };
    let url = Url::parse(raw.trim()).map_err(|e| invalid(&e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("scheme must be http or https"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(invalid("missing host"));
    }
    Ok(url)
}

/// Builds the header map with `append`, keeping order and duplicates. For multipart bodies the
/// user's Content-Type is dropped: the boundary must come from the generated form.
fn build_headers(pairs: &[(String, String)], is_multipart: bool) -> Result<HeaderMap, CoreError> {
    let mut headers = HeaderMap::with_capacity(pairs.len());
    for (name, value) in pairs {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            CoreError::new(ErrorKind::Other, format!("invalid header name: {name}"))
        })?;
        if is_multipart && header_name == CONTENT_TYPE {
            continue;
        }
        let header_value = HeaderValue::from_str(value).map_err(|_| {
            CoreError::new(ErrorKind::Other, format!("invalid value for header {name}"))
        })?;
        headers.append(header_name, header_value);
    }
    Ok(headers)
}

async fn attach_body(
    request: RequestBuilder,
    body: &BodySpec,
    has_content_type: bool,
) -> Result<RequestBuilder, CoreError> {
    Ok(match body {
        BodySpec::None => request,
        BodySpec::Text(text) => request.body(text.clone()),
        BodySpec::Base64(encoded) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|e| {
                    CoreError::new(ErrorKind::Other, format!("invalid base64 body: {e}"))
                })?;
            request.body(bytes)
        }
        BodySpec::UrlEncoded(pairs) => {
            let encoded = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(pairs)
                .finish();
            let request = if has_content_type {
                request
            } else {
                request.header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            };
            request.body(encoded)
        }
        BodySpec::Multipart(parts) => request.multipart(build_form(parts).await?),
    })
}

async fn build_form(parts: &[MultipartPart]) -> Result<Form, CoreError> {
    let mut form = Form::new();
    for part in parts {
        let built = match &part.value {
            PartValue::Text(text) => Part::text(text.clone()),
            PartValue::File {
                path,
                file_name,
                content_type,
            } => file_part(path, file_name.as_deref(), content_type.as_deref()).await?,
        };
        form = form.part(part.name.clone(), built);
    }
    Ok(form)
}

/// A part streamed from disk; the file is never loaded into memory whole.
async fn file_part(
    path: &str,
    file_name: Option<&str>,
    content_type: Option<&str>,
) -> Result<Part, CoreError> {
    let io_err =
        |e: std::io::Error| CoreError::new(ErrorKind::Io, format!("cannot read file {path}: {e}"));
    let file = tokio::fs::File::open(path).await.map_err(io_err)?;
    let len = file.metadata().await.map_err(io_err)?.len();
    let file_name = file_name.map(str::to_string).unwrap_or_else(|| {
        Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let content_type = content_type.map(str::to_string).unwrap_or_else(|| {
        mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string()
    });
    Part::stream_with_length(file, len)
        .file_name(file_name)
        .mime_str(&content_type)
        .map_err(|e| {
            CoreError::new(
                ErrorKind::Other,
                format!("invalid content type {content_type}: {e}"),
            )
        })
}

fn version_label(version: Version) -> String {
    match version {
        Version::HTTP_09 => "HTTP/0.9",
        Version::HTTP_10 => "HTTP/1.0",
        Version::HTTP_11 => "HTTP/1.1",
        Version::HTTP_2 => "HTTP/2",
        Version::HTTP_3 => "HTTP/3",
        _ => "HTTP",
    }
    .to_string()
}

fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}
