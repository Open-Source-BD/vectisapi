//! Cookie jar view and edits for the Cookies modal. Edits are persisted (debounced).

use tauri::State;
use vectis_core::cookies::CookieView;

use crate::state::AppState;

#[tauri::command]
pub fn cookies_list(state: State<'_, AppState>) -> Vec<CookieView> {
    state.jar.list()
}

#[tauri::command]
pub fn cookies_delete(state: State<'_, AppState>, domain: String, path: String, name: String) {
    state.jar.delete(&domain, &path, &name);
    state.jar_persister.schedule();
}

#[tauri::command]
pub fn cookies_clear_domain(state: State<'_, AppState>, domain: String) {
    state.jar.clear_domain(&domain);
    state.jar_persister.schedule();
}

#[tauri::command]
pub fn cookies_clear(state: State<'_, AppState>) {
    state.jar.clear();
    state.jar_persister.schedule();
}
