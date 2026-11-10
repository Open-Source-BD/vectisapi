//! Local axum test server for the HTTP engine integration tests.

use std::io::Write;
use std::net::SocketAddr;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

pub const JSON_FIXTURE: &[u8] = br#"{"hello":"world","n":[1,2,3]}"#;

/// Highly compressible payload served pre-compressed by `/compressed/{enc}`.
pub fn compressible() -> Vec<u8> {
    b"vectis compressible payload line\n".repeat(4096)
}

/// FNV-1a 64-bit, used to compare large bodies without shipping them back.
pub fn fnv64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn router() -> Router {
    Router::new()
        .route("/json", get(json_fixture))
        .route("/echo-headers", any(echo_headers))
        .route("/multi-set-cookie", get(multi_set_cookie))
        .route("/echo-body", post(echo_body))
        .route("/multipart", post(multipart))
        .route("/redirect/{n}", get(redirect))
        .route("/set-cookie-redirect", get(set_cookie_redirect))
        .route("/redirect-to", any(redirect_to))
        .route("/compressed/{enc}", get(compressed))
        .route("/sleep/{ms}", get(sleep))
        .route("/slow-stream", get(slow_stream))
        .route("/user-agent", get(user_agent))
        .layer(DefaultBodyLimit::disable())
}

/// Starts the plain HTTP server; returns its base URL (`http://127.0.0.1:port`).
pub async fn spawn() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router()).await.unwrap();
    });
    format!("http://{addr}")
}

/// Starts an HTTPS server with a freshly generated self-signed certificate.
pub async fn spawn_tls() -> String {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_string()]).unwrap();
    let config = axum_server::tls_rustls::RustlsConfig::from_pem(
        cert.cert.pem().into_bytes(),
        cert.signing_key.serialize_pem().into_bytes(),
    )
    .await
    .unwrap();
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    std_listener.set_nonblocking(true).unwrap();
    let addr: SocketAddr = std_listener.local_addr().unwrap();
    let server = axum_server::from_tcp_rustls(std_listener, config).unwrap();
    tokio::spawn(async move {
        server.serve(router().into_make_service()).await.unwrap();
    });
    format!("https://{addr}")
}

async fn json_fixture() -> Response {
    ([(header::CONTENT_TYPE, "application/json")], JSON_FIXTURE).into_response()
}

async fn echo_headers(headers: HeaderMap) -> Json<Value> {
    let pairs: Vec<[String; 2]> = headers
        .iter()
        .map(|(k, v)| [k.as_str().to_string(), v.to_str().unwrap_or("").to_string()])
        .collect();
    Json(json!(pairs))
}

async fn multi_set_cookie() -> Response {
    let mut res = "ok".into_response();
    for c in ["a=1", "b=2", "c=3"] {
        res.headers_mut()
            .append(header::SET_COOKIE, c.parse().unwrap());
    }
    res
}

async fn echo_body(headers: HeaderMap, body: Bytes) -> Response {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    ([("x-echo-content-type", ct)], body).into_response()
}

async fn multipart(mut mp: Multipart) -> Json<Value> {
    let mut parts = Vec::new();
    while let Some(field) = mp.next_field().await.unwrap() {
        let name = field.name().unwrap_or("").to_string();
        let file_name = field.file_name().map(str::to_string);
        let content_type = field.content_type().map(str::to_string);
        let data = field.bytes().await.unwrap();
        parts.push(json!({
            "name": name,
            "fileName": file_name,
            "contentType": content_type,
            "len": data.len(),
            "hash": fnv64(&data).to_string(),
            "text": if data.len() <= 1024 { String::from_utf8_lossy(&data).to_string() } else { String::new() },
        }));
    }
    Json(json!(parts))
}

async fn redirect(Path(n): Path<u32>) -> Response {
    if n == 0 {
        "done".into_response()
    } else {
        Redirect::to(&format!("/redirect/{}", n - 1)).into_response()
    }
}

/// Sets `a=1` and redirects (303) to `/echo-headers`.
async fn set_cookie_redirect() -> Response {
    let mut res = Redirect::to("/echo-headers").into_response();
    res.headers_mut()
        .append(header::SET_COOKIE, "a=1; Path=/".parse().unwrap());
    res
}

/// Redirects to `?to=<url>` with status `?status=<code>` (default 302).
async fn redirect_to(Query(q): Query<std::collections::HashMap<String, String>>) -> Response {
    let status = q
        .get("status")
        .and_then(|s| s.parse::<u16>().ok())
        .and_then(|s| StatusCode::from_u16(s).ok())
        .unwrap_or(StatusCode::FOUND);
    (status, [(header::LOCATION, q["to"].clone())]).into_response()
}

async fn compressed(Path(enc): Path<String>) -> Response {
    let raw = compressible();
    let body = match enc.as_str() {
        "gzip" => {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(&raw).unwrap();
            e.finish().unwrap()
        }
        "br" => {
            let mut out = Vec::new();
            {
                let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
                w.write_all(&raw).unwrap();
            }
            out
        }
        "zstd" => zstd::encode_all(&raw[..], 3).unwrap(),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    assert!(
        body.len() < raw.len() / 10,
        "payload must really be compressed"
    );
    ([(header::CONTENT_ENCODING, enc)], body).into_response()
}

async fn sleep(Path(ms): Path<u64>) -> &'static str {
    tokio::time::sleep(Duration::from_millis(ms)).await;
    "slept"
}

async fn slow_stream() -> Response {
    let stream = futures_util::stream::unfold((), |()| async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        Some((Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 1024])), ()))
    });
    Body::from_stream(stream).into_response()
}

async fn user_agent(headers: HeaderMap) -> String {
    headers
        .get_all(header::USER_AGENT)
        .iter()
        .map(|v| v.to_str().unwrap_or("").to_string())
        .collect::<Vec<_>>()
        .join("|")
}
