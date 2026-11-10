//! Writing response bodies to disk and opening the data folder.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use vectis_core::error::{CoreError, ErrorKind};

use crate::state::AppState;

/// Writes the full stored body to `path` (from the save dialog), exact bytes.
#[tauri::command]
pub async fn save_response_body(
    state: State<'_, AppState>,
    response_id: String,
    path: PathBuf,
) -> Result<(), CoreError> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || store.save_to_file(&response_id, &path))
        .await
        .map_err(|e| CoreError::new(ErrorKind::Other, format!("saving body failed: {e}")))?
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
