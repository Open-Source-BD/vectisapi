//! Forward-only schema migrations and startup recovery for the SQLite file.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, ErrorCode};

use crate::error::{CoreError, ErrorKind};

/// Ordered, append-only migration scripts. Index `i` upgrades schema `i` to `i + 1`.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE collections (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE environments (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL,
    vars_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE globals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    vars_json TEXT NOT NULL
);
CREATE TABLE active_env (
    k INTEGER PRIMARY KEY CHECK (k = 1),
    id TEXT
);
CREATE TABLE history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    ts INTEGER NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX history_method_url ON history (method, url);
CREATE INDEX history_ts ON history (ts DESC, seq DESC);
CREATE VIRTUAL TABLE history_fts USING fts5(method, url, tokenize = 'unicode61');
CREATE TRIGGER history_fts_ai AFTER INSERT ON history BEGIN
    INSERT INTO history_fts (rowid, method, url) VALUES (new.seq, new.method, new.url);
END;
CREATE TRIGGER history_fts_ad AFTER DELETE ON history BEGIN
    DELETE FROM history_fts WHERE rowid = old.seq;
END;
CREATE TABLE tabs (
    id TEXT PRIMARY KEY NOT NULL,
    sort INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE TABLE ui_state (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
);
CREATE TABLE cookies (
    domain TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (domain, path, name)
);
CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
);
"#];

/// Schema version this build understands.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

pub(super) fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    Ok(())
}

/// Brings the schema up to [`SCHEMA_VERSION`]; refuses a database written by a newer build.
pub(super) fn migrate(conn: &mut Connection) -> Result<(), CoreError> {
    let tx = conn.transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")?;
    let current: Option<u32> =
        tx.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))?;
    let current = current.unwrap_or(0);
    if current > SCHEMA_VERSION {
        return Err(CoreError::new(
            ErrorKind::Other,
            format!(
                "database schema version {current} is newer than this app supports ({SCHEMA_VERSION}); \
                 update VectisAPI. The database file was left untouched."
            ),
        ));
    }
    for (i, script) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        tx.execute_batch(script)?;
        tx.execute("DELETE FROM schema_version", [])?;
        tx.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [i as u32 + 1],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn is_corruption(err: &rusqlite::Error) -> bool {
    matches!(
        err.sqlite_error_code(),
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
    )
}

/// Opens (creating if needed) the database at `path`. A file that is not a valid SQLite
/// database is moved aside as `<name>.corrupt-<unix ts>` and replaced with a fresh one.
pub(super) fn open_file(path: &Path) -> Result<Connection, CoreError> {
    match try_open(path) {
        Ok(conn) => Ok(conn),
        Err(OpenFailure::Corrupt) => {
            move_aside(path)?;
            try_open(path).map_err(|e| match e {
                OpenFailure::Corrupt => {
                    CoreError::new(ErrorKind::Other, "fresh database is unreadable")
                }
                OpenFailure::Other(e) => e,
            })
        }
        Err(OpenFailure::Other(e)) => Err(e),
    }
}

enum OpenFailure {
    Corrupt,
    Other(CoreError),
}

impl From<rusqlite::Error> for OpenFailure {
    fn from(e: rusqlite::Error) -> Self {
        if is_corruption(&e) {
            Self::Corrupt
        } else {
            Self::Other(e.into())
        }
    }
}

fn try_open(path: &Path) -> Result<Connection, OpenFailure> {
    let mut conn = Connection::open(path)?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(OpenFailure::Corrupt);
    }
    apply_pragmas(&conn)?;
    migrate(&mut conn).map_err(OpenFailure::Other)?;
    Ok(conn)
}

fn move_aside(path: &Path) -> Result<(), CoreError> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let with_suffix = |suffix: &str| -> PathBuf {
        let mut s = path.as_os_str().to_owned();
        s.push(suffix);
        PathBuf::from(s)
    };
    std::fs::rename(path, with_suffix(&format!(".corrupt-{ts}")))?;
    for sib in ["-wal", "-shm"] {
        let from = with_suffix(sib);
        if from.exists() {
            std::fs::rename(&from, with_suffix(&format!("{sib}.corrupt-{ts}")))?;
        }
    }
    Ok(())
}
