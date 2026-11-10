//! Queries behind [`super::Db`]; every function runs on the DB thread.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{EntityOp, WorkspaceSnapshot};
use crate::error::{CoreError, ErrorKind};
use crate::settings::Settings;

const SETTINGS_KEY: &str = "settings";
const BACKUP_VERSION: u64 = 1;

/// Spec range for the history cap (§6.5).
pub const MIN_HISTORY_LIMIT: u32 = 50;
pub const MAX_HISTORY_LIMIT: u32 = 10_000;

/// Clamps any history limit (settings, caller argument) into the spec range.
pub fn clamp_history_limit(limit: u32) -> u32 {
    limit.clamp(MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
}

fn other(msg: impl Into<String>) -> CoreError {
    CoreError::new(ErrorKind::Other, msg)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parses `s` as JSON (the payload is stored as-is; this only rejects invalid input).
fn parse(s: &str) -> Result<Value, CoreError> {
    Ok(serde_json::from_str(s)?)
}

fn name_of(v: &Value) -> String {
    v.get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn json_rows(conn: &Connection, sql: &str) -> Result<Vec<Value>, CoreError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        // A row that no longer parses is skipped rather than bricking startup.
        if let Ok(v) = serde_json::from_str(&row?) {
            out.push(v);
        }
    }
    Ok(out)
}

fn read_settings(conn: &Connection) -> Result<Settings, CoreError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            [SETTINGS_KEY],
            |r| r.get(0),
        )
        .optional()?;
    let mut settings: Settings = raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    settings.history_limit = clamp_history_limit(settings.history_limit);
    Ok(settings)
}

fn history_rows(conn: &Connection, limit: u32) -> Result<Vec<Value>, CoreError> {
    let mut stmt =
        conn.prepare("SELECT data_json FROM history ORDER BY ts DESC, seq DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        if let Ok(v) = serde_json::from_str(&row?) {
            out.push(v);
        }
    }
    Ok(out)
}

pub fn load_workspace(conn: &Connection) -> Result<WorkspaceSnapshot, CoreError> {
    let settings = read_settings(conn)?;
    let globals: Option<String> = conn
        .query_row("SELECT vars_json FROM globals WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()?;
    let active_env_id: Option<String> = conn
        .query_row("SELECT id FROM active_env WHERE k = 1", [], |r| r.get(0))
        .optional()?
        .flatten();
    let cookies_json: Option<String> = conn
        .query_row("SELECT data_json FROM cookies LIMIT 1", [], |r| r.get(0))
        .optional()?;
    let mut ui_state = Map::new();
    {
        let mut stmt = conn.prepare("SELECT key, value_json FROM ui_state")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (k, v) = row?;
            if let Ok(v) = serde_json::from_str(&v) {
                ui_state.insert(k, v);
            }
        }
    }
    Ok(WorkspaceSnapshot {
        collections: json_rows(
            conn,
            "SELECT data_json FROM collections ORDER BY sort, rowid",
        )?,
        environments: json_rows(
            conn,
            "SELECT vars_json FROM environments ORDER BY sort, rowid",
        )?,
        globals: globals
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!([])),
        active_env_id,
        history: history_rows(conn, settings.history_limit)?,
        tabs: json_rows(conn, "SELECT data_json FROM tabs ORDER BY sort")?,
        ui_state,
        cookies_json,
        settings,
    })
}

fn apply_op(tx: &Transaction, op: EntityOp) -> Result<(), CoreError> {
    match op {
        EntityOp::UpsertCollection { id, sort, json } => {
            let v = parse(&json)?;
            tx.execute(
                "INSERT INTO collections (id, name, sort, data_json, updated_at) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort=excluded.sort,
                 data_json=excluded.data_json, updated_at=excluded.updated_at",
                params![id, name_of(&v), sort, json, now_ms()],
            )?;
        }
        EntityOp::DeleteCollection { id } => {
            tx.execute("DELETE FROM collections WHERE id = ?1", [id])?;
        }
        EntityOp::UpsertEnvironment { id, sort, json } => {
            let v = parse(&json)?;
            tx.execute(
                "INSERT INTO environments (id, name, sort, vars_json, updated_at) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort=excluded.sort,
                 vars_json=excluded.vars_json, updated_at=excluded.updated_at",
                params![id, name_of(&v), sort, json, now_ms()],
            )?;
        }
        EntityOp::DeleteEnvironment { id } => {
            tx.execute("DELETE FROM environments WHERE id = ?1", [id])?;
        }
        EntityOp::SetGlobals { json } => {
            parse(&json)?;
            tx.execute(
                "INSERT INTO globals (id, vars_json) VALUES (1, ?1)
                 ON CONFLICT(id) DO UPDATE SET vars_json=excluded.vars_json",
                [json],
            )?;
        }
        EntityOp::SetActiveEnv { id } => {
            tx.execute(
                "INSERT INTO active_env (k, id) VALUES (1, ?1)
                 ON CONFLICT(k) DO UPDATE SET id=excluded.id",
                [id],
            )?;
        }
        EntityOp::ReplaceTabs { tabs } => {
            for (_, json) in &tabs {
                parse(json)?;
            }
            tx.execute("DELETE FROM tabs", [])?;
            let mut stmt =
                tx.prepare("INSERT OR REPLACE INTO tabs (id, sort, data_json) VALUES (?1,?2,?3)")?;
            for (i, (id, json)) in tabs.iter().enumerate() {
                stmt.execute(params![id, i as i64, json])?;
            }
        }
        EntityOp::SetUiState { key, json } => {
            parse(&json)?;
            tx.execute(
                "INSERT INTO ui_state (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                params![key, json],
            )?;
        }
        EntityOp::SetCookies { json } => {
            parse(&json)?;
            // The whole jar is one opaque document (see `cookies::CookieJar::to_json`).
            tx.execute("DELETE FROM cookies", [])?;
            tx.execute(
                "INSERT INTO cookies (domain, path, name, data_json) VALUES ('*', '/', 'jar', ?1)",
                [json],
            )?;
        }
        EntityOp::SetSettings { json } => {
            let v = parse(&json)?;
            // Normalise the history limit when the payload is a valid Settings document.
            let json = match serde_json::from_value::<Settings>(v) {
                Ok(mut s) => {
                    s.history_limit = clamp_history_limit(s.history_limit);
                    serde_json::to_string(&s)?
                }
                Err(_) => json,
            };
            tx.execute(
                "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                params![SETTINGS_KEY, json],
            )?;
        }
        EntityOp::ClearHistory => {
            tx.execute("DELETE FROM history", [])?;
        }
        EntityOp::DeleteHistory { id } => {
            tx.execute("DELETE FROM history WHERE id = ?1", [id])?;
        }
    }
    Ok(())
}

pub fn save_entities(conn: &mut Connection, ops: Vec<EntityOp>) -> Result<(), CoreError> {
    let tx = conn.transaction()?;
    for op in ops {
        apply_op(&tx, op)?;
    }
    tx.commit()?;
    Ok(())
}

fn insert_history(
    tx: &Transaction,
    item_json: &str,
    method: &str,
    url: &str,
    status: u16,
    duration_ms: f64,
    ts: i64,
) -> Result<(), CoreError> {
    let item = parse(item_json)?;
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    tx.execute(
        "DELETE FROM history WHERE (method = ?1 AND url = ?2) OR id = ?3",
        params![method, url, id],
    )?;
    tx.execute(
        "INSERT INTO history (id, ts, method, url, status, duration_ms, data_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, ts, method, url, status, duration_ms, item_json],
    )?;
    Ok(())
}

fn prune_history(tx: &Transaction, limit: u32) -> Result<(), CoreError> {
    tx.execute(
        "DELETE FROM history WHERE seq NOT IN
         (SELECT seq FROM history ORDER BY ts DESC, seq DESC LIMIT ?1)",
        [limit],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn add_history(
    conn: &mut Connection,
    item_json: &str,
    method: &str,
    url: &str,
    status: u16,
    duration_ms: f64,
    ts: i64,
    limit: u32,
) -> Result<(), CoreError> {
    let tx = conn.transaction()?;
    insert_history(&tx, item_json, method, url, status, duration_ms, ts)?;
    prune_history(&tx, clamp_history_limit(limit))?;
    tx.commit()?;
    Ok(())
}

/// Builds an FTS5 MATCH expression: every alphanumeric-bearing token becomes a quoted prefix
/// term, so user input such as `"`, `-` or `*` can never be a syntax error. `None` = no terms.
fn fts_query(q: &str) -> Option<String> {
    let terms: Vec<String> = q
        .split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

pub fn search_history(conn: &Connection, q: &str, limit: u32) -> Result<Vec<String>, CoreError> {
    let collect = |mut stmt: rusqlite::Statement, args: &[&dyn rusqlite::ToSql]| {
        let rows = stmt.query_map(args, |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()
    };
    let limit = clamp_history_limit(limit);
    let out = match fts_query(q) {
        Some(m) => collect(
            conn.prepare(
                "SELECT h.data_json FROM history_fts f JOIN history h ON h.seq = f.rowid
                 WHERE history_fts MATCH ?1 ORDER BY h.ts DESC, h.seq DESC LIMIT ?2",
            )?,
            &[&m, &limit],
        )?,
        None => collect(
            conn.prepare("SELECT data_json FROM history ORDER BY ts DESC, seq DESC LIMIT ?1")?,
            &[&limit],
        )?,
    };
    Ok(out)
}

pub fn export_backup(conn: &Connection) -> Result<String, CoreError> {
    let snap = load_workspace(conn)?;
    // Backups carry the full history, not just the settings-capped view.
    let history = history_rows(conn, u32::MAX)?;
    let backup = json!({
        "version": BACKUP_VERSION,
        "collections": snap.collections,
        "environments": snap.environments,
        "globals": snap.globals,
        "activeEnvId": snap.active_env_id,
        "history": history,
        "tabs": snap.tabs,
        "uiState": snap.ui_state,
        "settings": snap.settings,
    });
    Ok(serde_json::to_string(&backup)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    #[serde(default)]
    collections: Vec<Value>,
    #[serde(default)]
    environments: Vec<Value>,
    #[serde(default = "empty_array")]
    globals: Value,
    #[serde(default)]
    active_env_id: Option<String>,
    #[serde(default)]
    history: Vec<Value>,
    #[serde(default)]
    tabs: Vec<Value>,
    #[serde(default)]
    ui_state: Map<String, Value>,
    #[serde(default)]
    settings: Settings,
}

fn empty_array() -> Value {
    json!([])
}

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn import_backup(conn: &mut Connection, text: &str) -> Result<(), CoreError> {
    let raw: Value = serde_json::from_str(text)?;
    let version = raw.get("version").and_then(Value::as_u64);
    if version != Some(BACKUP_VERSION) {
        return Err(other(format!(
            "unsupported backup version {}",
            version.map_or("(missing)".to_string(), |v| v.to_string())
        )));
    }
    let b: Backup = serde_json::from_value(raw)?;

    let tx = conn.transaction()?;
    for table in [
        "collections",
        "environments",
        "globals",
        "active_env",
        "history",
        "tabs",
        "ui_state",
        "settings",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    let mut ops = Vec::new();
    for (i, c) in b.collections.iter().enumerate() {
        ops.push(EntityOp::UpsertCollection {
            id: str_field(c, "id").to_string(),
            sort: i as i64,
            json: c.to_string(),
        });
    }
    for (i, e) in b.environments.iter().enumerate() {
        ops.push(EntityOp::UpsertEnvironment {
            id: str_field(e, "id").to_string(),
            sort: i as i64,
            json: e.to_string(),
        });
    }
    ops.push(EntityOp::SetGlobals {
        json: b.globals.to_string(),
    });
    ops.push(EntityOp::SetActiveEnv {
        id: b.active_env_id,
    });
    ops.push(EntityOp::ReplaceTabs {
        tabs: b
            .tabs
            .iter()
            .map(|t| (str_field(t, "id").to_string(), t.to_string()))
            .collect(),
    });
    for (key, v) in &b.ui_state {
        ops.push(EntityOp::SetUiState {
            key: key.clone(),
            json: v.to_string(),
        });
    }
    ops.push(EntityOp::SetSettings {
        json: serde_json::to_string(&b.settings)?,
    });
    for op in ops {
        apply_op(&tx, op)?;
    }
    // Backup history is newest-first; insert oldest-first so row order keeps that ranking.
    for (i, item) in b.history.iter().rev().enumerate() {
        insert_history(
            &tx,
            &item.to_string(),
            str_field(item, "method"),
            str_field(item, "url"),
            item.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
            item.get("time").and_then(Value::as_f64).unwrap_or(0.0),
            i as i64 + 1,
        )?;
    }
    prune_history(&tx, b.settings.history_limit)?;
    tx.commit()?;
    Ok(())
}
