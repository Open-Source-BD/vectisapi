//! WebSocket / SSE connections. Events stream to the UI over a per-connection `Channel`.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;
use vectis_core::error::CoreError;
use vectis_core::http::HttpRequestSpec;
use vectis_core::realtime::RtEvent;

use crate::state::{AppState, JarPersister};

/// The registry sink: forwards events to the UI channel. It runs under the connection's
/// delivery lock, so it must never panic and never call back into the `RtRegistry`.
fn channel_sink(
    channel: Channel<RtEvent>,
    persister: Arc<JarPersister>,
) -> impl Fn(RtEvent) + Send + Sync + 'static {
    move |event| {
        // The handshake / response headers may have set cookies.
        if matches!(event, RtEvent::Open) {
            persister.schedule();
        }
        // The webview may be gone (tab or window closed); nothing to do then.
        let _ = channel.send(event);
    }
}

#[tauri::command]
pub async fn rt_open_ws(
    state: State<'_, AppState>,
    conn_id: String,
    url: String,
    headers: Vec<(String, String)>,
    protocols: Vec<String>,
    on_event: Channel<RtEvent>,
) -> Result<(), CoreError> {
    let sink = channel_sink(on_event, state.jar_persister.clone());
    state
        .rt
        .open_ws(conn_id, url, headers, protocols, sink)
        .await
}

#[tauri::command]
pub async fn rt_open_sse(
    state: State<'_, AppState>,
    conn_id: String,
    spec: HttpRequestSpec,
    last_event_id: Option<String>,
    on_event: Channel<RtEvent>,
) -> Result<(), CoreError> {
    let sink = channel_sink(on_event, state.jar_persister.clone());
    state.rt.open_sse(conn_id, spec, last_event_id, sink).await
}

#[tauri::command]
pub async fn rt_send(
    state: State<'_, AppState>,
    conn_id: String,
    text: String,
) -> Result<(), CoreError> {
    state.rt.send_ws(&conn_id, text).await
}

#[tauri::command]
pub fn rt_close(state: State<'_, AppState>, conn_id: String) {
    state.rt.close(&conn_id);
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::Manager;
    use vectis_core::realtime::RtEvent;

    use super::channel_sink;
    use crate::state::AppState;
    use crate::test_support::app;

    #[test]
    fn sink_forwards_events_and_swallows_channel_errors() {
        let (app, _webview) = app();
        let persister = app.state::<AppState>().jar_persister.clone();

        let received = Arc::new(Mutex::new(Vec::new()));
        let log = received.clone();
        let ok = Channel::<RtEvent>::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                log.lock().unwrap().push(json);
            }
            Ok(())
        });
        let sink = channel_sink(ok, persister.clone());
        sink(RtEvent::Open);
        sink(RtEvent::Message {
            text: "hi".into(),
            bytes: 2,
            binary: false,
        });
        let received = received.lock().unwrap();
        assert_eq!(received[0], r#"{"type":"open"}"#);
        assert!(received[1].contains(r#""type":"message""#));

        // A dead webview must not take the sink (and the app, with panic=abort) down.
        let failing = Channel::<RtEvent>::new(|_| Err(tauri::Error::WebviewNotFound));
        let sink = channel_sink(failing, persister);
        sink(RtEvent::Open);
        sink(RtEvent::Error {
            message: "x".into(),
        });
    }
}
