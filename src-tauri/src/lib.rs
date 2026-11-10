mod commands;
mod picker;
mod state;
#[cfg(test)]
mod test_support;

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Builder, Emitter, Manager, RunEvent, Runtime, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::sync::oneshot;
use vectis_core::db::Db;

use crate::state::{AppState, ShutdownRequest};

/// Emitted on close; the frontend flushes pending writes and answers with `flush_done`.
pub const FLUSH_EVENT: &str = "vectis://flush";
/// How long the close flow waits for `flush_done`.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
/// Upper bound for the final cookie-jar write on close.
const JAR_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const DB_FILE: &str = "vectisapi.db";

/// Registers every IPC command (the TypeScript contract).
pub(crate) fn register_commands<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    use commands::{cookies, db, files, http, import, realtime, settings};
    builder.invoke_handler(tauri::generate_handler![
        http::send_request,
        http::cancel_request,
        http::get_response_body,
        files::save_response_body,
        files::open_data_dir,
        import::pick_next_postman_workspace,
        realtime::rt_open_ws,
        realtime::rt_open_sse,
        realtime::rt_send,
        realtime::rt_close,
        db::load_workspace,
        db::save_entities,
        db::add_history,
        db::search_history,
        db::export_backup,
        db::import_backup,
        db::flush_done,
        cookies::cookies_list,
        cookies::cookies_delete,
        cookies::cookies_clear_domain,
        cookies::cookies_clear,
        settings::get_settings,
        settings::set_settings,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            match open_state(app.handle()) {
                Ok(state) => {
                    app.manage(state);
                }
                Err(message) => fail_startup(app.handle(), message),
            }
            Ok(())
        })
        .on_window_event(on_window_event);
    register_commands(builder)
        .build(tauri::generate_context!())
        .expect("error while building VectisAPI")
        .run(on_run_event);
}

/// Opens `<app data dir>/vectisapi.db` and wires the state from its settings and cookies.
fn open_state<R: Runtime>(app: &AppHandle<R>) -> Result<AppState, String> {
    let data_dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot locate the app data folder: {e}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("cannot create {}: {e}", data_dir.display()))?;
    let db = Db::open(&data_dir.join(DB_FILE)).map_err(|e| e.message)?;
    let snapshot = tauri::async_runtime::block_on(db.load_workspace()).map_err(|e| e.message)?;
    Ok(AppState::new(
        db,
        &snapshot,
        data_dir,
        picker::dialog_picker(app.clone()),
    ))
}

/// Hides the window, shows the error natively and exits once it is dismissed.
fn fail_startup<R: Runtime>(app: &AppHandle<R>, message: String) {
    eprintln!("vectisapi: cannot open the database: {message}");
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "VectisAPI could not open its database and will quit.\n\n{message}"
        ))
        .title("VectisAPI")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if hold_for_shutdown(window.app_handle()) {
            api.prevent_close();
        }
    }
}

fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    // Covers quitting without closing the window (e.g. Cmd+Q on macOS).
    if let RunEvent::ExitRequested { api, .. } = event {
        if hold_for_shutdown(app) {
            api.prevent_exit();
        }
    }
}

/// Starts the shutdown flow on the first close/exit request. Returns whether the request must
/// be held (the flow exits the app itself when done).
fn hold_for_shutdown<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false; // startup failed: nothing to flush
    };
    match state.request_shutdown() {
        ShutdownRequest::Start => {
            tauri::async_runtime::spawn(shutdown(app.clone()));
            true
        }
        ShutdownRequest::Pending => true,
        ShutdownRequest::Allow => false,
    }
}

/// Runs [`prepare_exit`], then exits.
async fn shutdown<R: Runtime>(app: AppHandle<R>) {
    prepare_exit(&app).await;
    app.state::<AppState>().mark_shut_down();
    app.exit(0);
}

/// Lets the frontend flush (up to `FLUSH_TIMEOUT`), closes realtime connections and writes the
/// cookie jar. Never waits on the frontend longer than `FLUSH_TIMEOUT`.
async fn prepare_exit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let (tx, rx) = oneshot::channel();
    *state.flush_waiter.lock() = Some(tx);
    if app.emit(FLUSH_EVENT, ()).is_ok() {
        let _ = tokio::time::timeout(FLUSH_TIMEOUT, rx).await;
    }
    state.flush_waiter.lock().take();
    state.rt.close_all();
    match tokio::time::timeout(JAR_WRITE_TIMEOUT, state.jar_persister.write()).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => eprintln!("vectisapi: saving cookies failed: {}", err.message),
        Err(_) => eprintln!("vectisapi: saving cookies timed out"),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use serde_json::json;
    use tauri::Listener;
    use url::Url;

    use super::*;
    use crate::test_support::{app, invoke};

    #[test]
    fn close_flow_waits_for_flush_done() {
        let (app, webview) = app();
        let handle = app.handle().clone();
        let flushed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = flushed.clone();
        app.listen(FLUSH_EVENT, move |_| {
            seen.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        // The frontend answers 100 ms after the event.
        let wv = webview.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            invoke(&wv, "flush_done", json!({})).unwrap();
        });
        let started = Instant::now();
        tauri::async_runtime::block_on(prepare_exit(&handle));
        assert!(flushed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            started.elapsed() < Duration::from_millis(800),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn close_flow_gives_up_on_silent_frontend_and_saves_jar() {
        let (app, _webview) = app();
        let state = app.state::<AppState>();
        state.jar.store_response(
            &Url::parse("http://example.com/").unwrap(),
            &["sid=abc; Max-Age=3600".to_string()],
        );
        let started = Instant::now();
        tauri::async_runtime::block_on(prepare_exit(app.handle()));
        let elapsed = started.elapsed();
        assert!(
            elapsed >= FLUSH_TIMEOUT && elapsed < FLUSH_TIMEOUT * 2,
            "{elapsed:?}"
        );
        let snapshot = tauri::async_runtime::block_on(state.db.load_workspace()).unwrap();
        assert!(snapshot.cookies_json.unwrap().contains("abc"));
    }

    #[test]
    fn shutdown_request_starts_once_then_allows_after_done() {
        let (app, _webview) = app();
        let state = app.state::<AppState>();
        assert_eq!(state.request_shutdown(), ShutdownRequest::Start);
        assert_eq!(state.request_shutdown(), ShutdownRequest::Pending);
        state.mark_shut_down();
        assert_eq!(state.request_shutdown(), ShutdownRequest::Allow);
    }
}
