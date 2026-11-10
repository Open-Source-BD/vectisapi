//! Writing response bodies to user-picked files, atomic file writes, and the data folder.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use vectis_core::error::{CoreError, ErrorKind};

use crate::commands::http::body_gone;
use crate::picker::{pick, PickKind, PickRequest};
use crate::state::AppState;

/// Asks where to save, then writes the full stored body there (exact bytes). Returns the
/// chosen path, or `None` if the user cancelled.
#[tauri::command]
pub async fn save_response_body(
    state: State<'_, AppState>,
    response_id: String,
    suggested_name: Option<String>,
) -> Result<Option<String>, CoreError> {
    if state.store.len(&response_id).is_none() {
        return Err(body_gone());
    }
    let request = PickRequest {
        kind: PickKind::Save {
            file_name: suggested_name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| "response".to_string()),
        },
        title: "Save response body",
        filters: &[],
    };
    let Some(path) = pick(&state.picker, request).await else {
        return Ok(None);
    };
    let store = state.store.clone();
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || store.save_to_file(&response_id, &target))
        .await
        .map_err(|e| CoreError::new(ErrorKind::Other, format!("saving body failed: {e}")))?
        .map_err(|e| match e.kind {
            // Evicted while the dialog was open.
            ErrorKind::Other => body_gone(),
            _ => e,
        })?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Opens the folder holding the database in the OS file manager.
#[tauri::command]
pub fn open_data_dir<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), CoreError> {
    let dir = state.data_dir.to_string_lossy().into_owned();
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| CoreError::new(ErrorKind::Other, format!("cannot open data folder: {e}")))
}

/// Writes `contents` to a temporary file next to `path`, syncs it, then renames it over `path`,
/// so `path` holds either the old or the complete new contents.
pub(crate) async fn write_atomic(path: &Path, contents: Vec<u8>) -> Result<(), CoreError> {
    let file_name = path.file_name().ok_or_else(|| {
        CoreError::new(
            ErrorKind::Io,
            format!("not a file path: {}", path.display()),
        )
    })?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(format!(".tmp-{}", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let result = async {
        let mut file = tokio::fs::File::create(&tmp).await?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &contents).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result.map_err(CoreError::from)
}

/// `YYYY-MM-DD` (UTC) for `now`.
pub(crate) fn date_stamp(now: SystemTime) -> String {
    let days = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Days since 1970-01-01 → civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
pub(crate) fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("vectis-t7-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use axum::routing::get;
    use axum::Router;
    use parking_lot::Mutex;
    use serde_json::{json, Value};

    use super::*;
    use crate::test_support::{app, app_with_picker, invoke, invoke_json, serve};

    #[test]
    fn date_stamp_formats_utc_days() {
        assert_eq!(date_stamp(UNIX_EPOCH), "1970-01-01");
        // 2026-11-10T12:00:00Z
        let t = UNIX_EPOCH + Duration::from_secs(1_794_312_000);
        assert_eq!(date_stamp(t), "2026-11-10");
        // 2024-02-29 (leap day)
        assert_eq!(
            date_stamp(UNIX_EPOCH + Duration::from_secs(1_709_164_800)),
            "2024-02-29"
        );
    }

    #[test]
    fn write_atomic_replaces_file_and_leaves_no_temp() {
        let dir = temp_dir("atomic");
        let path = dir.join("out.json");
        std::fs::write(&path, b"old").unwrap();
        tauri::async_runtime::block_on(write_atomic(&path, b"new".to_vec())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn send(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, url: String) -> String {
        let frame = invoke(
            webview,
            "send_request",
            json!({ "spec": { "requestId": "s", "method": "GET", "url": url,
                              "headers": [], "body": { "type": "none" }, "timeoutMs": null } }),
        )
        .unwrap();
        let tauri::ipc::InvokeResponseBody::Raw(frame) = frame else {
            panic!("expected raw frame");
        };
        let len = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
        let meta: Value = serde_json::from_slice(&frame[4..4 + len]).unwrap();
        meta["responseId"].as_str().unwrap().to_string()
    }

    #[test]
    fn save_response_body_writes_to_picked_path_or_cancels() {
        let base = serve(Router::new().route("/b", get(|| async { &b"\x00\x01body"[..] })));
        let answer = Arc::new(Mutex::new(None));
        let (_app, webview) = app_with_picker(answer.clone());
        let id = send(&webview, format!("{base}/b"));

        let cancelled = invoke_json(&webview, "save_response_body", json!({ "responseId": id }));
        assert_eq!(cancelled, Value::Null);

        let dir = temp_dir("save");
        let path = dir.join("body.bin");
        *answer.lock() = Some(path.clone());
        let saved = invoke_json(
            &webview,
            "save_response_body",
            json!({ "responseId": id, "suggestedName": "body.bin" }),
        );
        assert_eq!(saved, json!(path.to_string_lossy()));
        assert_eq!(std::fs::read(&path).unwrap(), b"\x00\x01body");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_evicted_body_errors_before_dialog() {
        let (_app, webview) = app();
        let err = invoke(
            &webview,
            "save_response_body",
            json!({ "responseId": "gone" }),
        )
        .unwrap_err();
        assert_eq!(err["message"], "Response body no longer available");
    }
}
