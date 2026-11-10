//! WebSocket + SSE client tests against a local axum server, plus `SseParser` unit cases
//! ported from next-postman's `parseSse.test.ts`.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use parking_lot::Mutex;
use url::Url;
use vectis_core::cookies::CookieJar;
use vectis_core::http::{BodySpec, ClientPool, HttpRequestSpec};
use vectis_core::realtime::{RtEvent, RtRegistry, SseFrame, SseParser};
use vectis_core::settings::Settings;

// ---------------------------------------------------------------------------------------------
// SseParser

fn frame(event: &str, data: &str, id: Option<&str>, retry: Option<u64>) -> SseFrame {
    SseFrame {
        event: event.to_string(),
        data: data.to_string(),
        id: id.map(str::to_string),
        retry,
    }
}

#[test]
fn sse_parser_simple_event() {
    let mut p = SseParser::new();
    assert_eq!(
        p.push(b"data: hello\n\n"),
        vec![frame("message", "hello", None, None)]
    );
}

#[test]
fn sse_parser_multi_line_data_event_and_id() {
    let mut p = SseParser::new();
    let evs = p.push(b"event: chat\nid: 7\ndata: a\ndata: b\n\n");
    assert_eq!(evs, vec![frame("chat", "a\nb", Some("7"), None)]);
    assert_eq!(p.last_id(), Some("7"));
}

#[test]
fn sse_parser_frame_split_across_chunks() {
    let mut p = SseParser::new();
    assert_eq!(p.push(b"data: par"), vec![]);
    assert_eq!(
        p.push(b"tial\n\n"),
        vec![frame("message", "partial", None, None)]
    );
}

#[test]
fn sse_parser_comments_crlf_and_one_leading_space() {
    let mut p = SseParser::new();
    // comment + blank line, no data → no event
    assert_eq!(p.push(b": keep-alive\r\n\r\n"), vec![]);
    assert_eq!(
        p.push(b"data:no-space\r\n\r\n"),
        vec![frame("message", "no-space", None, None)]
    );
    // only one leading space is stripped
    assert_eq!(
        p.push(b"data:  two\n\n"),
        vec![frame("message", " two", None, None)]
    );
}

#[test]
fn sse_parser_strips_leading_bom() {
    let mut p = SseParser::new();
    assert_eq!(p.push("\u{feff}data: x\n\n".as_bytes())[0].data, "x");
}

#[test]
fn sse_parser_bom_split_across_chunks() {
    let mut p = SseParser::new();
    assert_eq!(p.push(&[0xEF, 0xBB]), vec![]);
    assert_eq!(
        p.push(b"\xBFdata: x\n\n"),
        vec![frame("message", "x", None, None)]
    );
}

#[test]
fn sse_parser_bom_only_at_stream_start() {
    let mut p = SseParser::new();
    p.push(b"data: a\n\n");
    let evs = p.push("\u{feff}data: b\n\n".as_bytes());
    // A BOM mid-stream is part of the field name, so the line is not a `data` field.
    assert_eq!(evs, vec![]);
}

#[test]
fn sse_parser_retry_and_last_id_kept_across_events() {
    let mut p = SseParser::new();
    p.push(b"id: 1\ndata: a\n\n");
    let evs = p.push(b"retry: 3000\ndata: b\n\n");
    assert_eq!(evs, vec![frame("message", "b", Some("1"), Some(3000))]);
    assert_eq!(p.last_id(), Some("1"));
    // retry resets after dispatch; non-numeric retry is ignored
    let evs = p.push(b"retry: soon\ndata: c\n\n");
    assert_eq!(evs, vec![frame("message", "c", Some("1"), None)]);
}

#[test]
fn sse_parser_id_with_nul_ignored() {
    let mut p = SseParser::new();
    p.push(b"id: 5\ndata: a\n\n");
    let evs = p.push(b"id: x\0y\ndata: b\n\n");
    assert_eq!(evs, vec![frame("message", "b", Some("5"), None)]);
}

#[test]
fn sse_parser_bare_cr_line_endings() {
    let mut p = SseParser::new();
    assert_eq!(
        p.push(b"event: e\rdata: a\rdata: b\r\r"),
        vec![frame("e", "a\nb", None, None)]
    );
}

#[test]
fn sse_parser_crlf_split_between_chunks() {
    let mut p = SseParser::new();
    assert_eq!(p.push(b"data: a\r"), vec![]);
    // The `\n` completing `\r\n` must not count as a blank line.
    assert_eq!(p.push(b"\ndata: b\r"), vec![]);
    assert_eq!(
        p.push(b"\n\r\n"),
        vec![frame("message", "a\nb", None, None)]
    );
}

#[test]
fn sse_parser_chunk_split_mid_line_every_byte() {
    let input = b"event: tick\nid: 42\ndata: hello\ndata: world\n\n: ping\n\ndata: z\n\n";
    let mut p = SseParser::new();
    let mut out = Vec::new();
    for b in input {
        out.extend(p.push(std::slice::from_ref(b)));
    }
    assert_eq!(
        out,
        vec![
            frame("tick", "hello\nworld", Some("42"), None),
            frame("message", "z", Some("42"), None),
        ]
    );
}

#[test]
fn sse_parser_utf8_split_across_chunks() {
    let text = "data: héllo → 世界 🦀\n\n".as_bytes();
    // split inside the 4-byte crab emoji and inside the 3-byte CJK char
    let crab = text.windows(4).position(|w| w == "🦀".as_bytes()).unwrap();
    let cjk = text.windows(3).position(|w| w == "世".as_bytes()).unwrap();
    let mut p = SseParser::new();
    let mut out = p.push(&text[..cjk + 1]);
    out.extend(p.push(&text[cjk + 1..crab + 2]));
    out.extend(p.push(&text[crab + 2..]));
    assert_eq!(out, vec![frame("message", "héllo → 世界 🦀", None, None)]);
}

#[test]
fn sse_parser_field_without_colon_and_unknown_fields() {
    let mut p = SseParser::new();
    // `data` alone is an empty data line; unknown fields are ignored.
    assert_eq!(
        p.push(b"foo: bar\ndata\ndata: x\n\n"),
        vec![frame("message", "\nx", None, None)]
    );
}

#[test]
fn rt_event_serializes_camel_case_tagged() {
    let ev = RtEvent::SseEvent {
        event: "message".into(),
        data: "d".into(),
        id: Some("1".into()),
    };
    assert_eq!(
        serde_json::to_value(&ev).unwrap(),
        serde_json::json!({"type": "sseEvent", "event": "message", "data": "d", "id": "1"})
    );
    assert_eq!(
        serde_json::to_value(RtEvent::Open).unwrap(),
        serde_json::json!({"type": "open"})
    );
    assert_eq!(
        serde_json::to_value(RtEvent::Closed {
            code: Some(1000),
            reason: "r".into()
        })
        .unwrap(),
        serde_json::json!({"type": "closed", "code": 1000, "reason": "r"})
    );
}

// ---------------------------------------------------------------------------------------------
// Test server

#[derive(Clone, Default)]
struct ServerState {
    ws_connections: Arc<AtomicUsize>,
}

fn router(state: ServerState) -> Router {
    Router::new()
        .route("/ws/echo", get(ws_echo))
        .route("/ws/binary", get(ws_binary))
        .route("/ws/close", get(ws_close))
        .route("/ws/tick", get(ws_tick))
        .route("/sse/events", get(sse_events))
        .route("/sse/missing", get(sse_missing))
        .route("/sse/endless", get(sse_endless))
        .with_state(state)
}

async fn spawn() -> (String, ServerState) {
    let state = ServerState::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("127.0.0.1:{}", addr.port()), state)
}

async fn spawn_tls() -> String {
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
    let app = router(ServerState::default());
    tokio::spawn(async move {
        server.serve(app.into_make_service()).await.unwrap();
    });
    format!("127.0.0.1:{}", addr.port())
}

/// Requires `Authorization: Bearer t`; greets with the auth, cookie and negotiated protocol,
/// then echoes text frames.
async fn ws_echo(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<ServerState>,
) -> Response {
    let auth = header_str(&headers, "authorization");
    if auth != "Bearer t" {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    state.ws_connections.fetch_add(1, Ordering::SeqCst);
    let cookie = header_str(&headers, "cookie");
    let x_custom = header_str(&headers, "x-custom");
    ws.protocols(["chat"])
        .on_upgrade(move |mut socket: WebSocket| async move {
            let proto = socket
                .protocol()
                .map(|p| p.to_str().unwrap().to_string())
                .unwrap_or_default();
            let hello = format!("auth={auth};proto={proto};cookie={cookie};x={x_custom}");
            if socket.send(Message::Text(hello.into())).await.is_err() {
                return;
            }
            while let Some(Ok(msg)) = socket.recv().await {
                if let Message::Text(t) = msg {
                    if socket
                        .send(Message::Text(format!("echo:{}", t.as_str()).into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
        })
}

async fn ws_binary(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|mut socket: WebSocket| async move {
        let _ = socket
            .send(Message::Binary(vec![0u8, 1, 2, 255, 7].into()))
            .await;
        while let Some(Ok(_)) = socket.recv().await {}
    })
}

async fn ws_close(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|mut socket: WebSocket| async move {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: 4001,
                reason: "bye".into(),
            })))
            .await;
        while let Some(Ok(_)) = socket.recv().await {}
    })
}

/// Sends `tick N` every 10 ms until the client goes away.
async fn ws_tick(ws: WebSocketUpgrade, State(state): State<ServerState>) -> Response {
    state.ws_connections.fetch_add(1, Ordering::SeqCst);
    ws.on_upgrade(|mut socket: WebSocket| async move {
        for n in 0u64.. {
            if socket
                .send(Message::Text(format!("tick {n}").into()))
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
}

/// Echoes `Accept` and `Last-Event-ID` in the first event, sets a cookie, then sends two more
/// events (split across writes) and ends.
async fn sse_events(headers: HeaderMap) -> Response {
    let first = format!(
        "event: hello\ndata: accept={};last={};cookie={}\n\n",
        header_str(&headers, "accept"),
        header_str(&headers, "last-event-id"),
        header_str(&headers, "cookie"),
    );
    let chunks: Vec<Result<String, std::io::Error>> = vec![
        Ok(first),
        Ok(": heartbeat\n\nid: 9\nda".to_string()),
        Ok("ta: one\n\n".to_string()),
        Ok("data: two\ndata: lines\n\n".to_string()),
    ];
    let stream = futures_util::stream::iter(chunks);
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::SET_COOKIE, "sse=1; Path=/"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn sse_missing() -> Response {
    (StatusCode::NOT_FOUND, "nope").into_response()
}

async fn sse_endless() -> Response {
    let stream = futures_util::stream::unfold(0u64, |n| async move {
        if n > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Some((
            Ok::<_, std::io::Error>(format!("data: tick {n}\n\n")),
            n + 1,
        ))
    });
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}

fn header_str(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------------------------------
// Helpers

type Events = Arc<Mutex<Vec<RtEvent>>>;

fn collector() -> (Events, impl Fn(RtEvent) + Send + Sync + 'static) {
    let events: Events = Arc::default();
    let sink_events = events.clone();
    (events, move |ev| sink_events.lock().push(ev))
}

fn registry_with(settings: Settings) -> (RtRegistry, Arc<CookieJar>) {
    let jar = Arc::new(CookieJar::new());
    (
        RtRegistry::new(jar.clone(), ClientPool::new(&settings)),
        jar,
    )
}

fn registry() -> (RtRegistry, Arc<CookieJar>) {
    registry_with(Settings::default())
}

/// Waits until `pred` holds for the collected events (panics after 5 s).
async fn wait_for(events: &Events, what: &str, pred: impl Fn(&[RtEvent]) -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if pred(&events.lock()) {
            return;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for {what}; got {:?}", events.lock());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn is_terminal(ev: &RtEvent) -> bool {
    matches!(ev, RtEvent::Closed { .. } | RtEvent::Error { .. })
}

fn messages(events: &[RtEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            RtEvent::Message { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn sse_spec(url: String) -> HttpRequestSpec {
    HttpRequestSpec {
        request_id: "sse".into(),
        method: "GET".into(),
        url,
        headers: vec![("X-Trace".into(), "1".into())],
        body: BodySpec::None,
        timeout_ms: None,
    }
}

// ---------------------------------------------------------------------------------------------
// WebSocket

#[tokio::test]
async fn ws_echo_with_custom_headers_and_subprotocol() {
    let (addr, _) = spawn().await;
    let (rt, jar) = registry();
    jar.store_response(
        &Url::parse(&format!("http://{addr}/")).unwrap(),
        &["sid=abc; Path=/".to_string()],
    );
    let (events, sink) = collector();
    rt.open_ws(
        "c1".into(),
        format!("ws://{addr}/ws/echo"),
        vec![
            ("Authorization".into(), "Bearer t".into()),
            ("X-Custom".into(), "yes".into()),
        ],
        vec!["chat".into(), "superchat".into()],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "greeting", |e| messages(e).len() == 1).await;
    rt.send_ws("c1", "ping ✓".into()).await.unwrap();
    wait_for(&events, "echo", |e| messages(e).len() == 2).await;

    let evs = events.lock().clone();
    assert_eq!(evs[0], RtEvent::Connecting);
    assert_eq!(evs[1], RtEvent::Open);
    assert_eq!(
        evs[2],
        RtEvent::Message {
            text: "auth=Bearer t;proto=chat;cookie=sid=abc;x=yes".into(),
            bytes: 45,
            binary: false,
        }
    );
    assert_eq!(
        evs[3],
        RtEvent::Message {
            text: "echo:ping ✓".into(),
            bytes: "echo:ping ✓".len() as u64,
            binary: false,
        }
    );
    rt.close("c1");
}

#[tokio::test]
async fn ws_user_cookie_header_overrides_jar() {
    let (addr, _) = spawn().await;
    let (rt, jar) = registry();
    jar.store_response(
        &Url::parse(&format!("http://{addr}/")).unwrap(),
        &["sid=abc; Path=/".to_string()],
    );
    let (events, sink) = collector();
    rt.open_ws(
        "c1".into(),
        format!("ws://{addr}/ws/echo"),
        vec![
            ("Authorization".into(), "Bearer t".into()),
            ("Cookie".into(), "mine=1".into()),
        ],
        vec!["chat".into()],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "greeting", |e| messages(e).len() == 1).await;
    assert!(messages(&events.lock())[0].contains(";cookie=mine=1;"));
    rt.close("c1");
}

#[tokio::test]
async fn ws_handshake_rejected_is_error_event() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();
    let (events, sink) = collector();
    rt.open_ws(
        "c1".into(),
        format!("ws://{addr}/ws/echo"),
        vec![],
        vec![],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "error", |e| e.iter().any(is_terminal)).await;
    let evs = events.lock().clone();
    assert_eq!(evs.len(), 2, "{evs:?}");
    match &evs[1] {
        RtEvent::Error { message } => assert!(message.contains("401"), "{message}"),
        other => panic!("expected error, got {other:?}"),
    }
    // The connection is gone: sending fails, and the id can be reopened.
    assert!(rt.send_ws("c1", "x".into()).await.is_err());
}

#[tokio::test]
async fn ws_invalid_url_is_error() {
    let (rt, _) = registry();
    let (events, sink) = collector();
    let err = rt
        .open_ws("c1".into(), "ftp://x/".into(), vec![], vec![], sink)
        .await
        .unwrap_err();
    assert_eq!(err.kind, vectis_core::error::ErrorKind::InvalidUrl);
    assert!(events.lock().is_empty());
}

#[tokio::test]
async fn ws_binary_frame_reported() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();
    let (events, sink) = collector();
    rt.open_ws(
        "b".into(),
        format!("ws://{addr}/ws/binary"),
        vec![],
        vec![],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "binary", |e| messages(e).len() == 1).await;
    assert_eq!(
        events.lock()[2],
        RtEvent::Message {
            text: "[binary 5 bytes]".into(),
            bytes: 5,
            binary: true,
        }
    );
    rt.close("b");
}

#[tokio::test]
async fn ws_close_code_reason() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();
    let (events, sink) = collector();
    rt.open_ws(
        "c".into(),
        format!("ws://{addr}/ws/close"),
        vec![],
        vec![],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "closed", |e| e.iter().any(is_terminal)).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        events.lock().clone(),
        vec![
            RtEvent::Connecting,
            RtEvent::Open,
            RtEvent::Closed {
                code: Some(4001),
                reason: "bye".into()
            },
        ]
    );
    // Server-closed connection is unregistered: the id opens a fresh connection.
    let (events2, sink2) = collector();
    rt.open_ws(
        "c".into(),
        format!("ws://{addr}/ws/close"),
        vec![],
        vec![],
        sink2,
    )
    .await
    .unwrap();
    wait_for(&events2, "closed again", |e| e.iter().any(is_terminal)).await;
}

#[tokio::test]
async fn ws_open_idempotent() {
    let (addr, state) = spawn().await;
    let (rt, _) = registry();
    let (events, sink) = collector();
    let (events2, sink2) = collector();
    let url = format!("ws://{addr}/ws/tick");
    rt.open_ws("t".into(), url.clone(), vec![], vec![], sink)
        .await
        .unwrap();
    rt.open_ws("t".into(), url, vec![], vec![], sink2)
        .await
        .unwrap();
    wait_for(&events, "ticks", |e| messages(e).len() >= 3).await;
    assert_eq!(state.ws_connections.load(Ordering::SeqCst), 1);
    assert!(events2.lock().is_empty());
    rt.close("t");
}

#[tokio::test]
async fn ws_send_when_not_connected_errors() {
    let (rt, _) = registry();
    assert!(rt.send_ws("nope", "x".into()).await.is_err());
}

#[tokio::test]
async fn ws_verify_tls_off_accepts_self_signed() {
    let addr = spawn_tls().await;
    let (rt, _) = registry_with(Settings {
        verify_tls: false,
        ..Settings::default()
    });
    let (events, sink) = collector();
    rt.open_ws(
        "s".into(),
        format!("wss://{addr}/ws/binary"),
        vec![],
        vec![],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "binary over tls", |e| messages(e).len() == 1).await;
    rt.close("s");
}

#[tokio::test]
async fn ws_verify_tls_on_rejects_self_signed() {
    let addr = spawn_tls().await;
    let (rt, _) = registry();
    let (events, sink) = collector();
    rt.open_ws(
        "s".into(),
        format!("wss://{addr}/ws/binary"),
        vec![],
        vec![],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "tls error", |e| e.iter().any(is_terminal)).await;
    assert!(matches!(events.lock()[1], RtEvent::Error { .. }));
}

// ---------------------------------------------------------------------------------------------
// SSE

#[tokio::test]
async fn sse_stream_events_and_last_event_id_sent() {
    let (addr, _) = spawn().await;
    let (rt, jar) = registry();
    jar.store_response(
        &Url::parse(&format!("http://{addr}/")).unwrap(),
        &["pre=1; Path=/".to_string()],
    );
    let (events, sink) = collector();
    rt.open_sse(
        "s".into(),
        sse_spec(format!("http://{addr}/sse/events")),
        Some("41".into()),
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "stream end", |e| e.iter().any(is_terminal)).await;
    assert_eq!(
        events.lock().clone(),
        vec![
            RtEvent::Connecting,
            RtEvent::Open,
            RtEvent::SseEvent {
                event: "hello".into(),
                data: "accept=text/event-stream;last=41;cookie=pre=1".into(),
                id: None,
            },
            RtEvent::SseEvent {
                event: "message".into(),
                data: "one".into(),
                id: Some("9".into()),
            },
            RtEvent::SseEvent {
                event: "message".into(),
                data: "two\nlines".into(),
                id: Some("9".into()),
            },
            RtEvent::Closed {
                code: None,
                reason: "stream ended".into()
            },
        ]
    );
    let cookie = jar
        .header_for(&Url::parse(&format!("http://{addr}/")).unwrap())
        .unwrap();
    assert!(cookie.contains("sse=1"), "{cookie}");
}

#[tokio::test]
async fn sse_non_2xx_is_error_event() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();
    let (events, sink) = collector();
    rt.open_sse(
        "s".into(),
        sse_spec(format!("http://{addr}/sse/missing")),
        None,
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "error", |e| e.iter().any(is_terminal)).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        events.lock().clone(),
        vec![
            RtEvent::Connecting,
            RtEvent::Error {
                message: "Upstream responded 404 Not Found".into()
            },
        ]
    );
}

#[tokio::test]
async fn sse_open_idempotent() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();
    let (events, sink) = collector();
    let (events2, sink2) = collector();
    let spec = sse_spec(format!("http://{addr}/sse/endless"));
    rt.open_sse("s".into(), spec.clone(), None, sink)
        .await
        .unwrap();
    rt.open_sse("s".into(), spec, None, sink2).await.unwrap();
    wait_for(&events, "ticks", |e| e.len() >= 4).await;
    assert!(events2.lock().is_empty());
    rt.close("s");
}

#[tokio::test]
async fn sse_invalid_url_is_error() {
    let (rt, _) = registry();
    let (_, sink) = collector();
    let err = rt
        .open_sse("s".into(), sse_spec("ws://x/".into()), None, sink)
        .await
        .unwrap_err();
    assert_eq!(err.kind, vectis_core::error::ErrorKind::InvalidUrl);
}

// ---------------------------------------------------------------------------------------------
// close

async fn assert_close_stops(
    rt: &RtRegistry,
    id: &str,
    events: &Events,
    expected_code: Option<u16>,
) {
    wait_for(events, "some traffic", |e| e.len() >= 5).await;
    rt.close(id);
    let at_close = events.lock().len();
    assert_eq!(
        events.lock().last().unwrap(),
        &RtEvent::Closed {
            code: expected_code,
            reason: "closed by user".into()
        }
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(events.lock().len(), at_close, "{:?}", events.lock());
    let closed = events.lock().iter().filter(|e| is_terminal(e)).count();
    assert_eq!(closed, 1);
    // closing again is a no-op
    rt.close(id);
    assert_eq!(events.lock().len(), at_close);
}

#[tokio::test]
async fn close_stops_events() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();

    let (ws_events, ws_sink) = collector();
    rt.open_ws(
        "w".into(),
        format!("ws://{addr}/ws/tick"),
        vec![],
        vec![],
        ws_sink,
    )
    .await
    .unwrap();
    let (sse_events, sse_sink) = collector();
    rt.open_sse(
        "s".into(),
        sse_spec(format!("http://{addr}/sse/endless")),
        None,
        sse_sink,
    )
    .await
    .unwrap();

    assert_close_stops(&rt, "w", &ws_events, Some(1000)).await;
    assert_close_stops(&rt, "s", &sse_events, None).await;
    assert!(rt.send_ws("w", "x".into()).await.is_err());
}

#[tokio::test]
async fn close_all_stops_everything() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();
    let (a, sink_a) = collector();
    let (b, sink_b) = collector();
    rt.open_ws(
        "a".into(),
        format!("ws://{addr}/ws/tick"),
        vec![],
        vec![],
        sink_a,
    )
    .await
    .unwrap();
    rt.open_sse(
        "b".into(),
        sse_spec(format!("http://{addr}/sse/endless")),
        None,
        sink_b,
    )
    .await
    .unwrap();
    wait_for(&a, "a traffic", |e| e.len() >= 3).await;
    wait_for(&b, "b traffic", |e| e.len() >= 3).await;
    rt.close_all();
    let (na, nb) = (a.lock().len(), b.lock().len());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!((a.lock().len(), b.lock().len()), (na, nb));
    assert!(is_terminal(a.lock().last().unwrap()));
    assert!(is_terminal(b.lock().last().unwrap()));
}

#[tokio::test]
async fn panicking_sink_does_not_kill_runtime() {
    let (addr, _) = spawn().await;
    let (rt, _) = registry();
    let hits = Arc::new(AtomicUsize::new(0));
    let sink_hits = hits.clone();
    rt.open_ws(
        "p".into(),
        format!("ws://{addr}/ws/tick"),
        vec![],
        vec![],
        move |ev| {
            sink_hits.fetch_add(1, Ordering::SeqCst);
            if matches!(ev, RtEvent::Open) {
                panic!("sink failed");
            }
        },
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    // Connecting + the panicking Open; nothing after the sink failed.
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    // The connection was torn down and the id can be reused.
    let (events, sink) = collector();
    rt.open_ws(
        "p".into(),
        format!("ws://{addr}/ws/tick"),
        vec![],
        vec![],
        sink,
    )
    .await
    .unwrap();
    wait_for(&events, "ticks after reopen", |e| messages(e).len() >= 2).await;
    rt.close("p");
}
