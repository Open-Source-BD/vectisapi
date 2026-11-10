//! Native file dialogs opened from Rust, so commands only ever touch paths the user picked.
//! A seam (`FilePicker`) lets tests answer without a real dialog.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

/// A file-type filter: label and extensions (without dots).
pub type Filter = (&'static str, &'static [&'static str]);

pub enum PickKind {
    /// Save dialog prefilled with this file name.
    Save {
        file_name: String,
    },
    Open,
    /// Folder picker.
    Folder,
}

pub struct PickRequest {
    pub kind: PickKind,
    pub title: &'static str,
    pub filters: &'static [Filter],
}

/// Shows a dialog without blocking; the receiver yields the chosen path, or `None` on cancel.
pub type FilePicker = Box<dyn Fn(PickRequest) -> oneshot::Receiver<Option<PathBuf>> + Send + Sync>;

/// Awaits the user's choice. A dialog that vanished counts as a cancel.
pub async fn pick(picker: &FilePicker, request: PickRequest) -> Option<PathBuf> {
    picker(request).await.ok().flatten()
}

/// The real picker: tauri-plugin-dialog, attached to the main window when there is one.
pub fn dialog_picker<R: Runtime>(app: AppHandle<R>) -> FilePicker {
    Box::new(move |request| {
        let (tx, rx) = oneshot::channel();
        let mut builder = app.dialog().file().set_title(request.title);
        if let Some(window) = app.get_webview_window("main") {
            builder = builder.set_parent(&window);
        }
        for (name, extensions) in request.filters {
            builder = builder.add_filter(*name, extensions);
        }
        let reply = move |path: Option<tauri_plugin_dialog::FilePath>| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        };
        match request.kind {
            PickKind::Save { file_name } => builder.set_file_name(file_name).save_file(reply),
            PickKind::Open => builder.pick_file(reply),
            PickKind::Folder => builder.pick_folder(reply),
        }
        rx
    })
}

/// A picker that always answers `answer` (tests).
#[cfg(test)]
pub fn fixed_picker(answer: std::sync::Arc<parking_lot::Mutex<Option<PathBuf>>>) -> FilePicker {
    Box::new(move |_| {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(answer.lock().clone());
        rx
    })
}
