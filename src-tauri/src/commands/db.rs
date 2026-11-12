//! Workspace persistence, history and full backups.

use std::time::SystemTime;

use tauri::State;
use vectis_core::db::{EntityOp, WorkspaceSnapshot};
use vectis_core::error::CoreError;

use crate::commands::files::{date_stamp, write_atomic};
use crate::picker::{pick, Filter, PickKind, PickRequest};
use crate::state::AppState;

#[tauri::command]
pub async fn load_workspace(state: State<'_, AppState>) -> Result<WorkspaceSnapshot, CoreError> {
    state.db.load_workspace().await
}

#[tauri::command]
pub async fn save_entities(
    state: State<'_, AppState>,
    ops: Vec<EntityOp>,
) -> Result<(), CoreError> {
    state.db.save_entities(ops).await
}

/// Adds a history entry. `limit` defaults to the settings history limit.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn add_history(
    state: State<'_, AppState>,
    item_json: String,
    method: String,
    url: String,
    status: u16,
    duration_ms: f64,
    ts: i64,
    limit: Option<u32>,
) -> Result<(), CoreError> {
    let limit = limit.unwrap_or_else(|| state.settings.read().history_limit);
    state
        .db
        .add_history(item_json, method, url, status, duration_ms, ts, limit)
        .await
}

/// Matching history items (JSON strings), newest first.
#[tauri::command]
pub async fn search_history(
    state: State<'_, AppState>,
    q: String,
    limit: u32,
) -> Result<Vec<String>, CoreError> {
    state.db.search_history(q, limit).await
}

/// File types offered when importing a backup (workspace folders/zips: `pick_workspace_files`).
const IMPORT_FILTERS: &[Filter] = &[("VectisAPI backup", &["json"])];
const BACKUP_FILTERS: &[Filter] = &[("VectisAPI backup", &["json"])];

/// Asks where to save, then writes a full backup there atomically. Returns the chosen path, or
/// `None` if the user cancelled.
#[tauri::command]
pub async fn export_backup(state: State<'_, AppState>) -> Result<Option<String>, CoreError> {
    let request = PickRequest {
        kind: PickKind::Save {
            file_name: format!("vectisapi-backup-{}.json", date_stamp(SystemTime::now())),
        },
        title: "Export backup",
        filters: BACKUP_FILTERS,
    };
    let Some(path) = pick(&state.picker, request).await else {
        return Ok(None);
    };
    let json = state.db.export_backup().await?;
    write_atomic(&path, json.into_bytes()).await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Asks for a backup file, replaces the workspace with it and applies its settings. Returns the
/// chosen path, or `None` if the user cancelled. The frontend reloads with `load_workspace`.
#[tauri::command]
pub async fn import_backup(state: State<'_, AppState>) -> Result<Option<String>, CoreError> {
    let request = PickRequest {
        kind: PickKind::Open,
        title: "Import backup",
        filters: IMPORT_FILTERS,
    };
    let Some(path) = pick(&state.picker, request).await else {
        return Ok(None);
    };
    let json = tokio::fs::read_to_string(&path).await?;
    state.db.import_backup(json).await?;
    let snapshot = state.db.load_workspace().await?;
    state.apply_settings(snapshot.settings);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The frontend finished flushing pending writes after `vectis://flush`.
#[tauri::command]
pub fn flush_done(state: State<'_, AppState>) {
    if let Some(waiter) = state.flush_waiter.lock().take() {
        let _ = waiter.send(());
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parking_lot::Mutex;
    use serde_json::{json, Value};

    use crate::commands::files::temp_dir;
    use crate::test_support::{app, app_with_picker, invoke, invoke_json};

    #[test]
    fn backup_export_then_import_restores_and_applies_settings() {
        let dir = temp_dir("backup");
        let path = dir.join("backup.json");
        let answer = Arc::new(Mutex::new(None));

        let (_app, webview) = app_with_picker(answer.clone());
        invoke(
            &webview,
            "save_entities",
            json!({ "ops": [{ "op": "upsertCollection", "id": "c1", "sort": 0,
                              "json": "{\"id\":\"c1\",\"name\":\"API\"}" }] }),
        )
        .unwrap();
        let mut settings = invoke_json(&webview, "get_settings", json!({}));
        settings["timeoutMs"] = json!(777);
        invoke(&webview, "set_settings", json!({ "settings": settings })).unwrap();

        // Cancelled dialog: nothing written.
        assert_eq!(
            invoke_json(&webview, "export_backup", json!({})),
            Value::Null
        );
        assert!(!path.exists());

        *answer.lock() = Some(path.clone());
        let written = invoke_json(&webview, "export_backup", json!({}));
        assert_eq!(written, json!(path.to_string_lossy()));

        let (_app2, fresh) = app_with_picker(answer.clone());
        let read = invoke_json(&fresh, "import_backup", json!({}));
        assert_eq!(read, json!(path.to_string_lossy()));
        let snapshot = invoke_json(&fresh, "load_workspace", json!({}));
        assert_eq!(snapshot["collections"][0]["name"], "API");
        assert_eq!(
            invoke_json(&fresh, "get_settings", json!({}))["timeoutMs"],
            777
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn import_cancelled_changes_nothing() {
        let (_app, webview) = app();
        assert_eq!(
            invoke_json(&webview, "import_backup", json!({})),
            Value::Null
        );
    }

    #[test]
    fn add_history_then_search() {
        let (_app, webview) = app();
        invoke(
            &webview,
            "add_history",
            json!({ "itemJson": "{\"id\":\"h1\"}", "method": "GET",
                    "url": "https://api.test/users", "status": 200,
                    "durationMs": 12.5, "ts": 1 }),
        )
        .unwrap();
        let found = invoke_json(
            &webview,
            "search_history",
            json!({ "q": "users", "limit": 50 }),
        );
        assert_eq!(found, json!(["{\"id\":\"h1\"}"]));
    }

    #[test]
    fn flush_done_without_waiter_is_harmless() {
        let (_app, webview) = app();
        invoke(&webview, "flush_done", json!({})).unwrap();
    }
}
