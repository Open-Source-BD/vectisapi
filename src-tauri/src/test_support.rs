//! Mock-runtime app and IPC helpers for command tests.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use axum::Router;
use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow};
use vectis_core::db::Db;

use crate::picker::fixed_picker;
use crate::state::AppState;

/// An app with every command registered and state over an in-memory DB.
/// File dialogs answer with no choice (cancel).
pub fn app() -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    app_with_picker(Arc::default())
}

/// File dialogs answer with whatever `answer` holds at the time.
pub fn app_with_picker(
    answer: Arc<Mutex<Option<PathBuf>>>,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = crate::register_commands(mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let db = Db::open_in_memory().unwrap();
    let snapshot = tauri::async_runtime::block_on(db.load_workspace()).unwrap();
    app.manage(AppState::new(
        db,
        &snapshot,
        PathBuf::new(),
        fixed_picker(answer),
    ));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

/// Invokes `cmd` with camelCase JSON `args`, as the frontend would.
pub fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<InvokeResponseBody, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

/// `invoke` for commands returning JSON.
pub fn invoke_json(webview: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Value {
    invoke(webview, cmd, args)
        .unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
        .deserialize()
        .unwrap()
}

/// Serves `router` on a local port; returns `http://127.0.0.1:<port>`.
pub fn serve(router: Router) -> String {
    let listener =
        tauri::async_runtime::block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let addr = listener.local_addr().unwrap();
    tauri::async_runtime::spawn(async move { axum::serve(listener, router).await });
    format!("http://{addr}")
}
