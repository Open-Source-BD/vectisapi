//! HTTP send/cancel and response body access.

use tauri::ipc::Response;
use tauri::State;
use vectis_core::error::{CoreError, ErrorKind};
use vectis_core::http::{HttpRequestSpec, ResponseMeta};

use crate::state::AppState;

/// Sends the request. Returns `[u32 LE meta_len][meta JSON (utf-8)][body prefix bytes]`.
#[tauri::command]
pub async fn send_request(
    state: State<'_, AppState>,
    spec: HttpRequestSpec,
) -> Result<Response, CoreError> {
    let result = state.engine.send(spec).await;
    // Redirect hops may have stored cookies even when the send failed later.
    state.jar_persister.schedule();
    let (meta, prefix) = result?;
    Ok(Response::new(encode_frame(&meta, &prefix)?))
}

#[tauri::command]
pub fn cancel_request(state: State<'_, AppState>, request_id: String) -> bool {
    state.engine.cancel(&request_id)
}

/// Raw body bytes `start..end` (end exclusive; `None` = to the end). Async and off the async
/// workers: assembling a large range copies up to the store cap.
#[tauri::command]
pub async fn get_response_body(
    state: State<'_, AppState>,
    response_id: String,
    start: u64,
    end: Option<u64>,
) -> Result<Response, CoreError> {
    let store = state.store.clone();
    let range =
        tauri::async_runtime::spawn_blocking(move || store.get_range(&response_id, start, end))
            .await
            .map_err(|e| CoreError::new(ErrorKind::Other, format!("reading body failed: {e}")))?;
    range
        // Zero-copy when the range was freshly assembled (sole owner of its buffer).
        .map(|bytes| Response::new(Vec::from(bytes)))
        .ok_or_else(body_gone)
}

pub(crate) fn body_gone() -> CoreError {
    CoreError::new(ErrorKind::Other, "Response body no longer available")
}

fn encode_frame(meta: &ResponseMeta, prefix: &[u8]) -> Result<Vec<u8>, CoreError> {
    let meta_json = serde_json::to_vec(meta)
        .map_err(|e| CoreError::new(ErrorKind::Other, format!("cannot encode response: {e}")))?;
    let meta_len = u32::try_from(meta_json.len())
        .map_err(|_| CoreError::new(ErrorKind::Other, "response metadata too large"))?;
    let mut frame = Vec::with_capacity(4 + meta_json.len() + prefix.len());
    frame.extend_from_slice(&meta_len.to_le_bytes());
    frame.extend_from_slice(&meta_json);
    frame.extend_from_slice(prefix);
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use axum::routing::get;
    use axum::Router;
    use serde_json::{json, Value};
    use tauri::ipc::InvokeResponseBody;

    use std::time::Duration;

    use tauri::Manager;

    use crate::state::{AppState, JAR_PERSIST_DEBOUNCE};
    use crate::test_support::{app, invoke, invoke_json, serve};

    const BODY: &[u8] = b"\x00\xffhello \xc3\xa9 binary";

    fn spec(url: &str) -> Value {
        json!({
            "spec": {
                "requestId": "r1",
                "method": "GET",
                "url": url,
                "headers": [["x-test", "1"]],
                "body": { "type": "none" },
                "timeoutMs": null
            }
        })
    }

    #[test]
    fn send_request_binary_frame_decodes() {
        let base = serve(Router::new().route("/bin", get(|| async { BODY })));
        let (_app, webview) = app();
        let body = invoke(&webview, "send_request", spec(&format!("{base}/bin"))).unwrap();
        let InvokeResponseBody::Raw(frame) = body else {
            panic!("expected a raw response, got JSON");
        };
        let meta_len = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
        let meta: Value = serde_json::from_slice(&frame[4..4 + meta_len]).unwrap();
        assert_eq!(meta["status"], 200);
        assert_eq!(meta["size"], BODY.len());
        assert_eq!(meta["truncated"], false);
        assert!(meta["timing"]["totalMs"].is_number());
        assert_eq!(&frame[4 + meta_len..], BODY);

        // The full body is readable by response id.
        let response_id = meta["responseId"].as_str().unwrap();
        let range = invoke(
            &webview,
            "get_response_body",
            json!({ "responseId": response_id, "start": 2, "end": 7 }),
        )
        .unwrap();
        let InvokeResponseBody::Raw(range) = range else {
            panic!("expected a raw response, got JSON");
        };
        assert_eq!(range, &BODY[2..7]);
    }

    #[test]
    fn send_request_error_serializes_kind_and_message() {
        let (_app, webview) = app();
        let err = invoke(&webview, "send_request", spec("{{base}}/x")).unwrap_err();
        assert_eq!(err["kind"], "invalid_url");
        assert!(err["message"].as_str().unwrap().contains("invalid URL"));
    }

    #[test]
    fn evicted_body_is_other_error() {
        let (_app, webview) = app();
        let err = invoke(
            &webview,
            "get_response_body",
            json!({ "responseId": "gone", "start": 0, "end": null }),
        )
        .unwrap_err();
        assert_eq!(
            err,
            json!({ "kind": "other", "message": "Response body no longer available" })
        );
    }

    #[test]
    fn set_cookie_is_persisted_after_debounce() {
        let base = serve(Router::new().route(
            "/login",
            get(|| async { ([("set-cookie", "sid=s3cr3t; Path=/; Max-Age=3600")], "ok") }),
        ));
        let (app, webview) = app();
        invoke(&webview, "send_request", spec(&format!("{base}/login"))).unwrap();

        let state = app.state::<AppState>();
        let stored = || {
            tauri::async_runtime::block_on(state.db.load_workspace())
                .unwrap()
                .cookies_json
                .unwrap_or_default()
        };
        assert!(!stored().contains("s3cr3t"), "written before the debounce");
        std::thread::sleep(JAR_PERSIST_DEBOUNCE + Duration::from_millis(300));
        assert!(stored().contains("s3cr3t"));
        let listed = invoke_json(&webview, "cookies_list", json!({}));
        assert_eq!(listed[0]["name"], "sid");
        assert_eq!(listed[0]["httpOnly"], false);
    }
}
