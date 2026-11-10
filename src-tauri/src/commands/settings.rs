//! App settings: read, and save + apply to the engine.

use tauri::State;
use vectis_core::db::EntityOp;
use vectis_core::error::{CoreError, ErrorKind};
use vectis_core::settings::Settings;

use crate::state::AppState;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

/// Persists `settings`, then applies them (client rebuild, response store cap). Nothing is
/// applied if saving fails.
#[tauri::command]
pub async fn set_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), CoreError> {
    let json = serde_json::to_string(&settings)
        .map_err(|e| CoreError::new(ErrorKind::Other, format!("cannot encode settings: {e}")))?;
    state
        .db
        .save_entities(vec![EntityOp::SetSettings { json }])
        .await?;
    state.apply_settings(settings);
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::Manager;

    use crate::state::AppState;
    use crate::test_support::{app, invoke, invoke_json};

    #[test]
    fn set_settings_persists_and_applies() {
        let (app, webview) = app();
        let mut settings = invoke_json(&webview, "get_settings", json!({}));
        assert_eq!(settings["timeoutMs"], 30_000);
        settings["timeoutMs"] = json!(1234);
        settings["responseStoreCapBytes"] = json!(4096);
        invoke(&webview, "set_settings", json!({ "settings": settings })).unwrap();

        assert_eq!(invoke_json(&webview, "get_settings", json!({})), settings);
        let state = app.state::<AppState>();
        let stored = tauri::async_runtime::block_on(state.db.load_workspace()).unwrap();
        assert_eq!(stored.settings.timeout_ms, 1234);
        assert_eq!(stored.settings.response_store_cap_bytes, 4096);
    }

    #[test]
    fn invalid_proxy_setting_is_saved_and_surfaces_on_send() {
        let (_app, webview) = app();
        let mut settings = invoke_json(&webview, "get_settings", json!({}));
        settings["proxyUrl"] = json!("::not a url::");
        invoke(&webview, "set_settings", json!({ "settings": settings })).unwrap();
        let err = invoke(
            &webview,
            "send_request",
            json!({ "spec": {
                "requestId": "p", "method": "GET", "url": "http://127.0.0.1:9/",
                "headers": [], "body": { "type": "none" }, "timeoutMs": null
            }}),
        )
        .unwrap_err();
        assert!(err["message"].as_str().unwrap().contains("proxy"), "{err}");
    }
}
