//! Workspace persistence, history and full backups.

use std::path::PathBuf;

use tauri::State;
use vectis_core::db::{EntityOp, WorkspaceSnapshot};
use vectis_core::error::CoreError;

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

/// Writes a full backup to `path` (from the save dialog).
#[tauri::command]
pub async fn export_backup(state: State<'_, AppState>, path: PathBuf) -> Result<(), CoreError> {
    let json = state.db.export_backup().await?;
    tokio::fs::write(&path, json).await?;
    Ok(())
}

/// Replaces the workspace with the backup at `path` (from the open dialog) and applies its
/// settings. The frontend reloads with `load_workspace` afterwards.
#[tauri::command]
pub async fn import_backup(state: State<'_, AppState>, path: PathBuf) -> Result<(), CoreError> {
    let json = tokio::fs::read_to_string(&path).await?;
    state.db.import_backup(json).await?;
    let snapshot = state.db.load_workspace().await?;
    state.apply_settings(snapshot.settings);
    Ok(())
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
    use serde_json::json;

    use crate::test_support::{app, invoke, invoke_json};

    #[test]
    fn backup_export_then_import_restores_and_applies_settings() {
        let dir = std::env::temp_dir().join(format!("vectis-t7-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("backup.json");

        let (_app, webview) = app();
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
        invoke(&webview, "export_backup", json!({ "path": path })).unwrap();

        let (_app2, fresh) = app();
        invoke(&fresh, "import_backup", json!({ "path": path })).unwrap();
        let snapshot = invoke_json(&fresh, "load_workspace", json!({}));
        assert_eq!(snapshot["collections"][0]["name"], "API");
        assert_eq!(
            invoke_json(&fresh, "get_settings", json!({}))["timeoutMs"],
            777
        );
        std::fs::remove_dir_all(&dir).unwrap();
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
