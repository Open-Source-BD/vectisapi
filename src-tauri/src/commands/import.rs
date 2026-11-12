//! Reading a workspace (its exported `.zip` or its git folder) for migration.
//! Rust only collects the `*.json` files; the frontend parses them (`lib/workspaceFile.ts`).

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use tauri::State;
use vectis_core::error::{CoreError, ErrorKind};

use crate::picker::{pick, Filter, PickKind, PickRequest};
use crate::state::AppState;

/// Upper bound on the summed size of the `*.json` files read from one workspace.
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
/// Deepest directory level read from a folder (the root's entries are level 1). A workspace
/// nests one directory per collection folder, so this has to allow nested folders.
const MAX_DEPTH: usize = 16;
const ZIP_FILTERS: &[Filter] = &[("Workspace archive", &["zip"])];

/// Where the workspace comes from.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceSource {
    Zip,
    Folder,
}

/// One workspace file: its `/`-separated path relative to the zip/folder root, and its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub text: String,
}

/// Asks for a workspace zip or folder and returns its `*.json` files sorted by
/// path, or `None` if the user cancelled. Errors with "Workspace too large" past 50 MB.
#[tauri::command]
pub async fn pick_workspace_files(
    state: State<'_, AppState>,
    source: WorkspaceSource,
) -> Result<Option<Vec<WorkspaceFile>>, CoreError> {
    let request = match source {
        WorkspaceSource::Zip => PickRequest {
            kind: PickKind::Open,
            title: "Import workspace (zip)",
            filters: ZIP_FILTERS,
        },
        WorkspaceSource::Folder => PickRequest {
            kind: PickKind::Folder,
            title: "Import workspace folder",
            filters: &[],
        },
    };
    let Some(path) = pick(&state.picker, request).await else {
        return Ok(None);
    };
    let files = tauri::async_runtime::spawn_blocking(move || match source {
        WorkspaceSource::Zip => read_zip(&path, MAX_TOTAL_BYTES),
        WorkspaceSource::Folder => read_folder(&path, MAX_TOTAL_BYTES),
    })
    .await
    .map_err(|e| CoreError::new(ErrorKind::Other, format!("reading workspace failed: {e}")))??;
    Ok(Some(files))
}

fn too_large() -> CoreError {
    CoreError::new(ErrorKind::Other, "Workspace too large")
}

/// A `*.json` file outside hidden folders and macOS `__MACOSX` resource-fork copies.
fn is_workspace_json(rel: &str) -> bool {
    rel.ends_with(".json")
        && !rel
            .split('/')
            .any(|seg| seg.starts_with('.') || seg == "__MACOSX")
}

/// Reads at most `budget + 1` bytes of `reader`, adding them to `total`; errors once `total`
/// exceeds `cap`.
fn read_capped(reader: impl Read, total: &mut u64, cap: u64) -> Result<String, CoreError> {
    let mut buf = Vec::new();
    reader
        .take(cap.saturating_sub(*total) + 1)
        .read_to_end(&mut buf)?;
    *total += buf.len() as u64;
    if *total > cap {
        return Err(too_large());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn zip_error(err: zip::result::ZipError) -> CoreError {
    CoreError::new(ErrorKind::Other, format!("Not a valid zip file: {err}"))
}

/// The `*.json` entries of the zip at `path`, sorted by path.
pub(crate) fn read_zip(path: &Path, cap: u64) -> Result<Vec<WorkspaceFile>, CoreError> {
    let mut archive = zip::ZipArchive::new(BufReader::new(File::open(path)?)).map_err(zip_error)?;
    let mut total = 0;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(zip_error)?;
        if !entry.is_file() {
            continue;
        }
        // `enclosed_name` rejects absolute paths and `..` escapes.
        let Some(rel) = entry.enclosed_name().as_deref().and_then(slash_path) else {
            continue;
        };
        if !is_workspace_json(&rel) {
            continue;
        }
        let text = read_capped(entry, &mut total, cap)?;
        out.push(WorkspaceFile { path: rel, text });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// `a/b/c` from a relative path of normal UTF-8 components; `None` otherwise.
fn slash_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The `*.json` files under the folder `root` (symlinks not followed), sorted by path.
pub(crate) fn read_folder(root: &Path, cap: u64) -> Result<Vec<WorkspaceFile>, CoreError> {
    let mut out = Vec::new();
    let mut total = 0;
    walk(root, "", 1, &mut total, cap, &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn walk(
    dir: &Path,
    prefix: &str,
    depth: usize,
    total: &mut u64,
    cap: u64,
    out: &mut Vec<WorkspaceFile>,
) -> Result<(), CoreError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        // `DirEntry::file_type` does not follow symlinks, so links are skipped.
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            let hidden = rel.rsplit('/').next().is_some_and(|n| n.starts_with('.'));
            if depth < MAX_DEPTH && !hidden {
                walk(&entry.path(), &rel, depth + 1, total, cap, out)?;
            }
        } else if file_type.is_file() && is_workspace_json(&rel) {
            if *total + entry.metadata()?.len() > cap {
                return Err(too_large());
            }
            let text = read_capped(File::open(entry.path())?, total, cap)?;
            out.push(WorkspaceFile { path: rel, text });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Arc;

    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::commands::files::temp_dir;
    use crate::test_support::{app_with_picker, invoke, invoke_json};

    const COLLECTION: &str = "collections/000__API/_collection.json";
    const NESTED: &str = "collections/000__API/000__Auth/000__Admin/000__Deep/000__Login.json";
    const ENV: &str = "environments/000__Prod.json";
    const ENV_SECRET: &str = "environments/000__Prod.secret.json";

    /// The workspace layout plus files that must be skipped.
    fn fixture() -> Vec<(&'static str, &'static str)> {
        vec![
            (COLLECTION, r#"{"id":"c1","name":"API"}"#),
            (NESTED, r#"{"id":"r1","name":"Login"}"#),
            (ENV, r#"{"id":"e1","name":"Prod","vars":[]}"#),
            (ENV_SECRET, r#"{"id":"e1","vars":[{"key":"token"}]}"#),
            (".gitignore", "*.secret.json\n"),
            ("README.md", "# hi"),
            (".git/config.json", "{}"),
            ("__MACOSX/collections/._x.json", "\u{0}junk"),
        ]
    }

    fn paths(files: &[WorkspaceFile]) -> Vec<&str> {
        files.iter().map(|f| f.path.as_str()).collect()
    }

    fn expected() -> Vec<&'static str> {
        let mut want = vec![COLLECTION, NESTED, ENV, ENV_SECRET];
        want.sort_unstable();
        want
    }

    fn write_zip(path: &Path, files: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.add_directory("collections/", options).unwrap();
        for (name, text) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    fn write_folder(root: &Path, files: &[(&str, &str)]) {
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }

    #[test]
    fn reads_json_entries_from_zip_including_secrets() {
        let dir = temp_dir("np-zip");
        let path = dir.join("ws.zip");
        write_zip(&path, &fixture());
        let files = read_zip(&path, MAX_TOTAL_BYTES).unwrap();
        assert_eq!(paths(&files), expected());
        let secret = files.iter().find(|f| f.path == ENV_SECRET).unwrap();
        assert_eq!(secret.text, r#"{"id":"e1","vars":[{"key":"token"}]}"#);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_json_files_from_nested_folder() {
        let dir = temp_dir("np-folder");
        write_folder(&dir, &fixture());
        let files = read_folder(&dir, MAX_TOTAL_BYTES).unwrap();
        assert_eq!(paths(&files), expected());
        assert_eq!(
            files.iter().find(|f| f.path == NESTED).unwrap().text,
            r#"{"id":"r1","name":"Login"}"#
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn workspace_over_cap_is_too_large() {
        let dir = temp_dir("np-cap");
        let big = "x".repeat(600);
        let files = [("a.json", big.as_str()), ("b.json", big.as_str())];
        write_folder(&dir.join("f"), &files);
        write_zip(&dir.join("ws.zip"), &files);
        for err in [
            read_folder(&dir.join("f"), 1000).unwrap_err(),
            read_zip(&dir.join("ws.zip"), 1000).unwrap_err(),
        ] {
            assert_eq!(err.kind, ErrorKind::Other);
            assert_eq!(err.message, "Workspace too large");
        }
        // Exactly at the cap is fine.
        assert_eq!(read_folder(&dir.join("f"), 1200).unwrap().len(), 2);
        assert_eq!(read_zip(&dir.join("ws.zip"), 1200).unwrap().len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn command_reads_picked_zip_or_folder_and_handles_cancel_and_bad_zip() {
        let dir = temp_dir("np-cmd");
        let zip_path = dir.join("ws.zip");
        write_zip(&zip_path, &fixture());
        let folder = dir.join("folder");
        write_folder(&folder, &fixture());
        let answer: Arc<Mutex<Option<PathBuf>>> = Arc::default();
        let (_app, webview) = app_with_picker(answer.clone());
        let call = |source: &str| {
            invoke(
                &webview,
                "pick_workspace_files",
                json!({ "source": source }),
            )
        };

        assert_eq!(
            invoke_json(&webview, "pick_workspace_files", json!({ "source": "zip" })),
            Value::Null
        );

        for (source, path) in [("zip", &zip_path), ("folder", &folder)] {
            *answer.lock() = Some(path.clone());
            let files: Value = call(source).unwrap().deserialize().unwrap();
            let got: Vec<&str> = files
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["path"].as_str().unwrap())
                .collect();
            assert_eq!(got, expected(), "{source}");
            assert!(files[0]["text"].is_string());
        }

        let not_zip = dir.join("not.zip");
        std::fs::write(&not_zip, b"plain text").unwrap();
        *answer.lock() = Some(not_zip);
        let err = call("zip").unwrap_err();
        assert_eq!(err["kind"], "other");
        assert!(
            err["message"]
                .as_str()
                .unwrap()
                .starts_with("Not a valid zip file"),
            "{err}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
