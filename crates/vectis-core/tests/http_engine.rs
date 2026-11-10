#[path = "support/server.rs"]
mod server;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use vectis_core::cookies::CookieJar;
use vectis_core::error::ErrorKind;
use vectis_core::http::{
    BodySpec, ClientPool, HttpEngine, HttpRequestSpec, MultipartPart, PartValue, ResponseStore,
};
use vectis_core::settings::Settings;

fn setup_with(settings: Settings) -> (Arc<HttpEngine>, ClientPool, Arc<ResponseStore>) {
    let pool = ClientPool::new(&settings);
    let store = Arc::new(ResponseStore::new(settings.response_store_cap_bytes));
    let jar = Arc::new(CookieJar::new());
    let engine = Arc::new(HttpEngine::new(pool.clone(), store.clone(), jar));
    (engine, pool, store)
}

fn setup() -> (Arc<HttpEngine>, ClientPool, Arc<ResponseStore>) {
    setup_with(Settings::default())
}

fn spec(method: &str, url: impl Into<String>) -> HttpRequestSpec {
    HttpRequestSpec {
        request_id: format!("req-{}", url_safe_counter()),
        method: method.to_string(),
        url: url.into(),
        headers: vec![],
        body: BodySpec::None,
        timeout_ms: None,
    }
}

fn url_safe_counter() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

fn h(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

#[tokio::test]
async fn get_returns_status_headers_body() {
    let base = server::spawn().await;
    let (engine, _, _) = setup();
    let (meta, body) = engine
        .send(spec("GET", format!("{base}/json")))
        .await
        .unwrap();
    assert_eq!(meta.status, 200);
    assert_eq!(meta.status_text, "OK");
    assert_eq!(meta.http_version, "HTTP/1.1");
    assert!(meta
        .headers
        .contains(&h("content-type", "application/json")));
    assert_eq!(&body[..], server::JSON_FIXTURE);
    assert_eq!(meta.size, server::JSON_FIXTURE.len() as u64);
    assert!(!meta.truncated);
    assert!(meta.remote_addr.is_some());
    assert_eq!(meta.final_url, format!("{base}/json"));
    assert!(meta.timing.ttfb_ms <= meta.timing.total_ms);
}

#[tokio::test]
async fn request_headers_sent_in_order_with_duplicates() {
    let base = server::spawn().await;
    let (engine, _, _) = setup();
    let mut s = spec("GET", format!("{base}/echo-headers"));
    s.headers = vec![
        h("X-A", "1"),
        h("X-A", "2"),
        h("Host", "example.test"),
        h("Cookie", "a=b"),
    ];
    let (_, body) = engine.send(s).await.unwrap();
    let pairs: Vec<(String, String)> = serde_json::from_slice(&body).unwrap();
    let xa: Vec<&str> = pairs
        .iter()
        .filter(|(k, _)| k == "x-a")
        .map(|(_, v)| v.as_str())
        .collect();
    assert_eq!(xa, vec!["1", "2"]);
    assert!(pairs.contains(&h("host", "example.test")));
    assert!(pairs.contains(&h("cookie", "a=b")));
    assert_eq!(pairs.iter().filter(|(k, _)| k == "host").count(), 1);
}

#[tokio::test]
async fn duplicate_response_headers_preserved() {
    let base = server::spawn().await;
    let (engine, _, _) = setup();
    let (meta, _) = engine
        .send(spec("GET", format!("{base}/multi-set-cookie")))
        .await
        .unwrap();
    let cookies: Vec<&str> = meta
        .headers
        .iter()
        .filter(|(k, _)| k == "set-cookie")
        .map(|(_, v)| v.as_str())
        .collect();
    assert_eq!(cookies, vec!["a=1", "b=2", "c=3"]);
}

#[tokio::test]
async fn bodies_text_urlencoded_base64_multipart_file() {
    let base = server::spawn().await;
    let (engine, _, store) = setup();

    // text
    let mut s = spec("POST", format!("{base}/echo-body"));
    s.headers = vec![h("Content-Type", "text/plain")];
    s.body = BodySpec::Text("héllo body".into());
    let (meta, body) = engine.send(s).await.unwrap();
    assert_eq!(&body[..], "héllo body".as_bytes());
    assert!(meta
        .headers
        .contains(&h("x-echo-content-type", "text/plain")));

    // urlencoded
    let mut s = spec("POST", format!("{base}/echo-body"));
    s.body = BodySpec::UrlEncoded(vec![h("a b", "1&2"), h("a b", "3")]);
    let (meta, body) = engine.send(s).await.unwrap();
    assert_eq!(&body[..], b"a+b=1%262&a+b=3");
    assert!(meta.headers.contains(&h(
        "x-echo-content-type",
        "application/x-www-form-urlencoded"
    )));

    // base64 (non-UTF-8 bytes)
    let raw: Vec<u8> = vec![0, 159, 146, 150, 255, 1, 2];
    let mut s = spec("POST", format!("{base}/echo-body"));
    s.body = BodySpec::Base64("AJ+Slv8BAg==".into());
    let (_, body) = engine.send(s).await.unwrap();
    assert_eq!(&body[..], &raw[..]);

    // multipart with a 5 MB file streamed from disk
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.bin");
    let data: Vec<u8> = (0..5 * 1024 * 1024u32)
        .map(|i| (i * 31 % 251) as u8)
        .collect();
    std::fs::write(&path, &data).unwrap();
    let mut s = spec("POST", format!("{base}/multipart"));
    // A user-supplied multipart Content-Type (without boundary) must not break the request.
    s.headers = vec![h("Content-Type", "multipart/form-data")];
    s.body = BodySpec::Multipart(vec![
        MultipartPart {
            name: "field".into(),
            value: PartValue::Text("value 1".into()),
        },
        MultipartPart {
            name: "upload".into(),
            value: PartValue::File {
                path: path.to_string_lossy().into_owned(),
                file_name: Some("renamed.bin".into()),
                content_type: Some("application/octet-stream".into()),
            },
        },
        MultipartPart {
            name: "default-name".into(),
            value: PartValue::File {
                path: path.to_string_lossy().into_owned(),
                file_name: None,
                content_type: None,
            },
        },
    ]);
    let (meta, body) = engine.send(s).await.unwrap();
    assert_eq!(meta.status, 200, "{}", String::from_utf8_lossy(&body));
    let full = store.get_range(&meta.response_id, 0, None).unwrap();
    let parts: Vec<Value> = serde_json::from_slice(&full).unwrap();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0]["name"], "field");
    assert_eq!(parts[0]["text"], "value 1");
    assert_eq!(parts[1]["name"], "upload");
    assert_eq!(parts[1]["fileName"], "renamed.bin");
    assert_eq!(parts[1]["contentType"], "application/octet-stream");
    assert_eq!(parts[1]["len"], data.len());
    assert_eq!(parts[1]["hash"], server::fnv64(&data).to_string());
    assert_eq!(parts[2]["fileName"], "big.bin");
    assert_eq!(parts[2]["hash"], server::fnv64(&data).to_string());

    // missing file → io error kind
    let mut s = spec("POST", format!("{base}/multipart"));
    s.body = BodySpec::Multipart(vec![MultipartPart {
        name: "f".into(),
        value: PartValue::File {
            path: dir.path().join("missing").to_string_lossy().into_owned(),
            file_name: None,
            content_type: None,
        },
    }]);
    assert_eq!(engine.send(s).await.unwrap_err().kind, ErrorKind::Io);
}

#[tokio::test]
async fn redirects_followed_and_capped() {
    let base = server::spawn().await;
    let (engine, _, _) = setup();
    let (meta, body) = engine
        .send(spec("GET", format!("{base}/redirect/3")))
        .await
        .unwrap();
    assert_eq!(meta.status, 200);
    assert_eq!(meta.final_url, format!("{base}/redirect/0"));
    assert_eq!(&body[..], b"done");

    let err = engine
        .send(spec("GET", format!("{base}/redirect/11")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Other);
    assert!(err.message.contains("redirect"), "{}", err.message);

    // follow_redirects off → the 3xx itself is returned
    let (engine, _, _) = setup_with(Settings {
        follow_redirects: false,
        ..Settings::default()
    });
    let (meta, _) = engine
        .send(spec("GET", format!("{base}/redirect/3")))
        .await
        .unwrap();
    assert_eq!(meta.status, 303);
    assert_eq!(meta.final_url, format!("{base}/redirect/3"));
}

#[tokio::test]
async fn decompresses_gzip_brotli_zstd() {
    let base = server::spawn().await;
    let (engine, _, _) = setup();
    let raw = server::compressible();
    for enc in ["gzip", "br", "zstd"] {
        let (meta, body) = engine
            .send(spec("GET", format!("{base}/compressed/{enc}")))
            .await
            .unwrap();
        assert_eq!(meta.status, 200, "{enc}");
        assert_eq!(meta.size, raw.len() as u64, "{enc}");
        assert_eq!(&body[..], &raw[..], "{enc}");
    }
}

#[tokio::test]
async fn timeout_kind() {
    let base = server::spawn().await;
    let (engine, _, _) = setup();
    let mut s = spec("GET", format!("{base}/sleep/2000"));
    s.timeout_ms = Some(200);
    let started = Instant::now();
    let err = engine.send(s).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Timeout, "{}", err.message);
    assert!(started.elapsed() < Duration::from_millis(1500));
}

#[tokio::test]
async fn cancel_mid_body() {
    let base = server::spawn().await;
    let (engine, _, _) = setup();
    let s = spec("GET", format!("{base}/slow-stream"));
    let id = s.request_id.clone();
    let task = {
        let engine = engine.clone();
        tokio::spawn(async move { engine.send(s).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let cancelled_at = Instant::now();
    assert!(engine.cancel(&id));
    let err = task.await.unwrap().unwrap_err();
    assert!(cancelled_at.elapsed() < Duration::from_millis(100));
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(
        !engine.cancel(&id),
        "finished requests are no longer cancellable"
    );
}

#[tokio::test]
async fn connection_refused_kind() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (engine, _, _) = setup();
    let err = engine
        .send(spec("GET", format!("http://127.0.0.1:{port}/")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConnectionRefused, "{}", err.message);
}

#[tokio::test]
async fn dns_kind() {
    let (engine, _, _) = setup();
    let err = engine
        .send(spec("GET", "http://nonexistent.invalid/"))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Dns, "{}", err.message);
}

#[tokio::test]
async fn invalid_url_is_error_kind() {
    let (engine, _, _) = setup();
    for url in ["http://", "{{base}}/x", "not a url", "ftp://example.com/"] {
        let err = engine.send(spec("GET", url)).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidUrl, "{url}: {}", err.message);
    }
}

#[tokio::test]
async fn self_signed_tls_fails_then_passes_with_verify_off() {
    let base = server::spawn_tls().await;
    let (engine, pool, _) = setup();
    let err = engine
        .send(spec("GET", format!("{base}/json")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Tls, "{}", err.message);

    pool.update(&Settings {
        verify_tls: false,
        ..Settings::default()
    });
    let (meta, body) = engine
        .send(spec("GET", format!("{base}/json")))
        .await
        .unwrap();
    assert_eq!(meta.status, 200);
    assert_eq!(&body[..], server::JSON_FIXTURE);
}

#[tokio::test]
async fn default_user_agent_unless_set() {
    let base = server::spawn().await;
    let (engine, pool, _) = setup();
    let (_, body) = engine
        .send(spec("GET", format!("{base}/user-agent")))
        .await
        .unwrap();
    assert_eq!(
        &body[..],
        format!("VectisAPI/{}", env!("CARGO_PKG_VERSION")).as_bytes()
    );

    let mut s = spec("GET", format!("{base}/user-agent"));
    s.headers = vec![h("user-agent", "custom/1")];
    let (_, body) = engine.send(s).await.unwrap();
    assert_eq!(&body[..], b"custom/1");

    pool.update(&Settings {
        user_agent: Some("from-settings/2".into()),
        ..Settings::default()
    });
    let (_, body) = engine
        .send(spec("GET", format!("{base}/user-agent")))
        .await
        .unwrap();
    assert_eq!(&body[..], b"from-settings/2");
}

async fn echo(
    engine: &HttpEngine,
    base: &str,
    data: &[u8],
) -> Result<(vectis_core::http::ResponseMeta, bytes::Bytes), vectis_core::error::CoreError> {
    use base64::Engine as _;
    let mut s = spec("POST", format!("{base}/echo-body"));
    s.body = BodySpec::Base64(base64::engine::general_purpose::STANDARD.encode(data));
    engine.send(s).await
}

fn pseudo_random(len: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

#[tokio::test]
async fn prefix_is_2mb_and_truncated_flag() {
    let base = server::spawn().await;
    let (engine, _, store) = setup();
    let data = vec![7u8; 5 * 1024 * 1024];
    let (meta, prefix) = echo(&engine, &base, &data).await.unwrap();
    assert_eq!(meta.size, 5 * 1024 * 1024);
    assert!(meta.truncated);
    assert_eq!(prefix.len(), 2_097_152);
    assert_eq!(store.len(&meta.response_id), Some(data.len() as u64));

    let (meta, prefix) = echo(&engine, &base, &[1u8; 1024]).await.unwrap();
    assert!(!meta.truncated);
    assert_eq!(meta.size, 1024);
    assert_eq!(prefix.len(), 1024);
}

#[tokio::test]
async fn get_range_returns_exact_slice() {
    let base = server::spawn().await;
    let (engine, _, store) = setup();
    let data = pseudo_random(3 * 1024 * 1024);
    let (meta, _) = echo(&engine, &base, &data).await.unwrap();
    let id = &meta.response_id;
    let (start, end) = (1_000_003usize, 2_500_017usize);
    let got = store.get_range(id, start as u64, Some(end as u64)).unwrap();
    assert_eq!(&got[..], &data[start..end]);
    let tail = store.get_range(id, 3 * 1024 * 1024 - 10, None).unwrap();
    assert_eq!(&tail[..], &data[data.len() - 10..]);
    assert!(store
        .get_range(id, 0, Some(u64::MAX))
        .is_some_and(|b| b.len() == data.len()));
    assert_eq!(store.get_range(id, 50, Some(10)).unwrap().len(), 0);
    assert!(store.get_range("missing", 0, None).is_none());
}

#[tokio::test]
async fn binary_body_roundtrip_exact_bytes() {
    let base = server::spawn().await;
    let (engine, _, store) = setup();
    let data = pseudo_random(3 * 1024 * 1024);
    assert!(std::str::from_utf8(&data).is_err());
    let (meta, _) = echo(&engine, &base, &data).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.bin");
    store.save_to_file(&meta.response_id, &path).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), data);
    let err = store.save_to_file("missing", &path).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Other);
}

#[test]
fn lru_evicts_oldest_when_over_cap() {
    use bytes::Bytes;
    let mb = 1024 * 1024;
    let store = ResponseStore::new(10 * mb as u64);
    let put = |id: &str| {
        let mut w = store.begin(id);
        w.push(Bytes::from(vec![0u8; 4 * mb])).unwrap();
        w.finish();
    };
    put("a");
    put("b");
    // Reading "a" makes "b" the least recently used.
    assert!(store.get_range("a", 0, Some(1)).is_some());
    put("c");
    assert_eq!(store.len("b"), None);
    assert_eq!(store.len("a"), Some(4 * mb as u64));
    put("d");
    assert_eq!(store.len("a"), None);
    assert_eq!(store.len("c"), Some(4 * mb as u64));
    assert_eq!(store.len("d"), Some(4 * mb as u64));
    assert_eq!(store.used_bytes(), 8 * mb as u64);
}

#[test]
fn eviction_never_drops_the_body_being_written() {
    use bytes::Bytes;
    let store = ResponseStore::new(10);
    let mut old = store.begin("old");
    old.push(Bytes::from_static(&[0; 6])).unwrap();
    old.finish();
    let mut cur = store.begin("cur");
    cur.push(Bytes::from_static(&[1; 4])).unwrap();
    cur.push(Bytes::from_static(&[1; 4])).unwrap();
    assert_eq!(store.len("old"), None);
    assert_eq!(store.used_bytes(), 8);
    assert_eq!(cur.finish(), 8);
    assert_eq!(store.len("cur"), Some(8));
}

#[test]
fn over_cap_across_chunks_releases_partial_body() {
    use bytes::Bytes;
    let kb = 1024;
    let store = ResponseStore::new(1024 * kb as u64);
    let mut w = store.begin("big");
    w.push(Bytes::from(vec![0u8; 600 * kb])).unwrap();
    assert_eq!(store.used_bytes(), 600 * kb as u64);
    let err = w.push(Bytes::from(vec![0u8; 600 * kb])).unwrap_err();
    assert_eq!(err.kind, ErrorKind::BodyTooLarge);
    assert_eq!(store.used_bytes(), 0);
    drop(w);
    assert_eq!(store.used_bytes(), 0);
    assert_eq!(store.len("big"), None);
}

#[test]
fn dropped_writer_without_finish_releases_bytes() {
    use bytes::Bytes;
    let store = ResponseStore::new(1024);
    let mut w = store.begin("abandoned");
    w.push(Bytes::from_static(&[1; 100])).unwrap();
    assert_eq!(store.used_bytes(), 100);
    drop(w);
    assert_eq!(store.used_bytes(), 0);
    assert_eq!(store.len("abandoned"), None);
}

#[tokio::test]
async fn body_over_cap_errors() {
    let base = server::spawn().await;
    let mb = 1024 * 1024;
    let (engine, _, store) = setup_with(Settings {
        response_store_cap_bytes: mb as u64,
        ..Settings::default()
    });
    let before = store.used_bytes();
    let err = echo(&engine, &base, &vec![3u8; 2 * mb]).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::BodyTooLarge);
    assert_eq!(store.used_bytes(), before);
    // A body that fits still works afterwards.
    let (meta, _) = echo(&engine, &base, &vec![3u8; mb / 2]).await.unwrap();
    assert_eq!(store.len(&meta.response_id), Some(mb as u64 / 2));
    assert_eq!(store.used_bytes(), mb as u64 / 2);
}

#[test]
fn ipc_types_serialize_camel_case() {
    use vectis_core::error::CoreError;
    let err = CoreError::new(ErrorKind::ConnectionRefused, "nope");
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        serde_json::json!({"kind": "connection_refused", "message": "nope"})
    );
    let body: BodySpec = serde_json::from_value(serde_json::json!({
        "type": "multipart",
        "value": [{"name": "f", "value": {"type": "file", "value": {"path": "/x", "fileName": null, "contentType": "a/b"}}}]
    }))
    .unwrap();
    assert!(matches!(body, BodySpec::Multipart(ref p) if p.len() == 1));
    let spec_json = serde_json::json!({
        "requestId": "r1", "method": "GET", "url": "http://x/",
        "headers": [["a", "b"]], "body": {"type": "none"}, "timeoutMs": null
    });
    let s: HttpRequestSpec = serde_json::from_value(spec_json.clone()).unwrap();
    assert_eq!(s.headers, vec![h("a", "b")]);
    assert_eq!(serde_json::to_value(&s).unwrap(), spec_json);
    let settings = serde_json::to_value(Settings::default()).unwrap();
    assert_eq!(settings["timeoutMs"], 30_000);
    assert_eq!(settings["maxRedirects"], 10);
    assert_eq!(settings["responseStoreCapBytes"], 512u64 * 1024 * 1024);
    assert_eq!(settings["historyLimit"], 1000);
}
