use std::time::Instant;

use serde_json::{json, Value};
use vectis_core::db::{Db, EntityOp, SCHEMA_VERSION};

fn item(id: &str, method: &str, url: &str) -> String {
    json!({"id": id, "method": method, "url": url, "status": 200, "time": 12.5, "date": "x"})
        .to_string()
}

async fn add(db: &Db, id: &str, method: &str, url: &str, ts: i64, limit: u32) {
    db.add_history(
        item(id, method, url),
        method.into(),
        url.into(),
        200,
        12.5,
        ts,
        limit,
    )
    .await
    .unwrap();
}

fn ids(v: &[Value]) -> Vec<String> {
    v.iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

fn all_kinds() -> Vec<EntityOp> {
    vec![
        EntityOp::UpsertCollection {
            id: "c1".into(),
            sort: 1,
            json: json!({"id":"c1","name":"B"}).to_string(),
        },
        EntityOp::UpsertCollection {
            id: "c0".into(),
            sort: 0,
            json: json!({"id":"c0","name":"A"}).to_string(),
        },
        EntityOp::UpsertEnvironment {
            id: "e1".into(),
            sort: 0,
            json: json!({"id":"e1","name":"Dev","vars":[]}).to_string(),
        },
        EntityOp::SetGlobals {
            json: json!([{"key":"k","value":"v"}]).to_string(),
        },
        EntityOp::SetActiveEnv {
            id: Some("e1".into()),
        },
        EntityOp::ReplaceTabs {
            tabs: vec![
                ("t1".into(), json!({"id":"t1"}).to_string()),
                ("t2".into(), json!({"id":"t2"}).to_string()),
            ],
        },
        EntityOp::SetUiState {
            key: "activeTab".into(),
            json: json!("t2").to_string(),
        },
        EntityOp::SetCookies { json: "[]".into() },
        EntityOp::SetSettings {
            json: json!({"timeoutMs": 5000, "historyLimit": 77}).to_string(),
        },
    ]
}

#[test]
fn migrations_idempotent_and_versioned() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectisapi.db");
    drop(Db::open(&path).unwrap());
    drop(Db::open(&path).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let (n, v): (u32, u32) = conn
        .query_row(
            "SELECT COUNT(*), MAX(version) FROM schema_version",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((n, v), (1, SCHEMA_VERSION));
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[tokio::test]
async fn reopen_after_write_persists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectisapi.db");
    let db = Db::open(&path).unwrap();
    db.save_entities(all_kinds()).await.unwrap();
    add(&db, "h1", "GET", "https://a.test/users/1", 1, 100).await;
    let before = db.load_workspace().await.unwrap();
    drop(db);
    let after = Db::open(&path).unwrap().load_workspace().await.unwrap();
    assert_eq!(before, after);
    assert_eq!(after.collections[0]["name"], "A");
    assert_eq!(after.active_env_id.as_deref(), Some("e1"));
    assert_eq!(after.tabs.len(), 2);
    assert_eq!(after.ui_state["activeTab"], "t2");
    assert_eq!(after.cookies_json.as_deref(), Some("[]"));
    assert_eq!(after.settings.timeout_ms, 5000);
    assert_eq!(after.history.len(), 1);
}

#[tokio::test]
async fn history_dedupes_method_url_and_moves_to_top() {
    let db = Db::open_in_memory().unwrap();
    add(&db, "a", "GET", "https://x.test/a", 1, 100).await;
    add(&db, "b", "GET", "https://x.test/b", 2, 100).await;
    add(&db, "c", "POST", "https://x.test/a", 3, 100).await;
    add(&db, "a2", "GET", "https://x.test/a", 4, 100).await;
    let h = db.load_workspace().await.unwrap().history;
    assert_eq!(ids(&h), ["a2", "c", "b"]);
    let found = db.search_history("x.test".into(), 10).await.unwrap();
    assert_eq!(found.len(), 3);
}

#[tokio::test]
async fn history_cap_prunes_oldest() {
    let db = Db::open_in_memory().unwrap();
    for i in 0..51 {
        add(
            &db,
            &format!("h{i}"),
            "GET",
            &format!("https://x.test/{i}"),
            i,
            50,
        )
        .await;
    }
    let h = db.load_workspace().await.unwrap().history;
    assert_eq!(h.len(), 50);
    assert_eq!(h[0]["id"], "h50");
    assert_eq!(h[49]["id"], "h1");
    // pruned rows are gone from the search index too
    assert_eq!(
        db.search_history(String::new(), 100).await.unwrap().len(),
        50
    );
}

#[tokio::test]
async fn history_search_handles_hostile_input_and_prefixes() {
    let db = Db::open_in_memory().unwrap();
    add(&db, "a", "GET", "https://x.test/users/1", 1, 100).await;
    add(&db, "b", "POST", "https://x.test/orders", 2, 100).await;
    assert_eq!(db.search_history("user".into(), 10).await.unwrap().len(), 1);
    assert_eq!(
        db.search_history("post ord".into(), 10)
            .await
            .unwrap()
            .len(),
        1
    );
    for q in [
        "\"",
        "-",
        "*",
        "a OR",
        "\"unterminated",
        "(",
        "NEAR(",
        "x:y",
        "   ",
    ] {
        db.search_history(q.into(), 10).await.unwrap();
    }
    assert_eq!(db.search_history(String::new(), 1).await.unwrap().len(), 1);
}

#[tokio::test]
#[cfg_attr(debug_assertions, ignore = "timing only meaningful in release")]
async fn history_search_fts_10k_under_50ms() {
    let db = Db::open_in_memory().unwrap();
    for i in 0..10_000 {
        let url = if i % 10 == 0 {
            format!("https://api.test/users/{i}")
        } else {
            format!("https://api.test/items/{i}")
        };
        add(&db, &format!("h{i}"), "GET", &url, i, 10_000).await;
    }
    let t = Instant::now();
    let r = db.search_history("users".into(), 1000).await.unwrap();
    let elapsed = t.elapsed();
    assert_eq!(r.len(), 1000);
    assert!(elapsed.as_millis() < 50, "search took {elapsed:?}");
}

#[tokio::test]
async fn save_entities_is_atomic() {
    let db = Db::open_in_memory().unwrap();
    let mut ops = all_kinds();
    ops.push(EntityOp::UpsertCollection {
        id: "bad".into(),
        sort: 9,
        json: "{not json".into(),
    });
    let err = db.save_entities(ops).await.unwrap_err();
    assert!(!err.message.is_empty());
    let ws = db.load_workspace().await.unwrap();
    assert!(ws.collections.is_empty() && ws.environments.is_empty() && ws.tabs.is_empty());
    assert!(ws.active_env_id.is_none());
    // the db thread is still alive after the error
    db.save_entities(vec![EntityOp::SetActiveEnv { id: None }])
        .await
        .unwrap();
}

#[tokio::test]
async fn delete_and_clear_ops() {
    let db = Db::open_in_memory().unwrap();
    db.save_entities(all_kinds()).await.unwrap();
    add(&db, "h1", "GET", "https://x.test/1", 1, 100).await;
    add(&db, "h2", "GET", "https://x.test/2", 2, 100).await;
    db.save_entities(vec![
        EntityOp::DeleteCollection { id: "c0".into() },
        EntityOp::DeleteEnvironment { id: "e1".into() },
        EntityOp::DeleteHistory { id: "h1".into() },
    ])
    .await
    .unwrap();
    let ws = db.load_workspace().await.unwrap();
    assert_eq!(ws.collections.len(), 1);
    assert!(ws.environments.is_empty());
    assert_eq!(ids(&ws.history), ["h2"]);
    db.save_entities(vec![EntityOp::ClearHistory])
        .await
        .unwrap();
    assert!(db.load_workspace().await.unwrap().history.is_empty());
    assert!(db.search_history("x".into(), 10).await.unwrap().is_empty());
}

#[test]
fn entity_op_wire_format() {
    let op: EntityOp =
        serde_json::from_value(json!({"op":"upsertCollection","id":"a","sort":1,"json":"{}"}))
            .unwrap();
    assert!(matches!(op, EntityOp::UpsertCollection { .. }));
    let op: EntityOp = serde_json::from_value(json!({"op":"clearHistory"})).unwrap();
    assert_eq!(op, EntityOp::ClearHistory);
}

#[tokio::test]
async fn backup_roundtrip() {
    let src = Db::open_in_memory().unwrap();
    src.save_entities(all_kinds()).await.unwrap();
    add(&src, "h1", "GET", "https://x.test/1", 1, 100).await;
    add(&src, "h2", "GET", "https://x.test/2", 2, 100).await;
    let json = src.export_backup().await.unwrap();
    let v: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["version"], 1);
    assert!(v.get("cookies").is_none() && v.get("cookiesJson").is_none());

    let dst = Db::open_in_memory().unwrap();
    add(&dst, "old", "GET", "https://old.test/", 5, 100).await;
    dst.import_backup(json.clone()).await.unwrap();
    let (a, b) = (
        src.load_workspace().await.unwrap(),
        dst.load_workspace().await.unwrap(),
    );
    assert_eq!(a.collections, b.collections);
    assert_eq!(a.environments, b.environments);
    assert_eq!(a.globals, b.globals);
    assert_eq!(a.active_env_id, b.active_env_id);
    assert_eq!(a.tabs, b.tabs);
    assert_eq!(a.ui_state, b.ui_state);
    assert_eq!(a.settings, b.settings);
    assert_eq!(ids(&b.history), ["h2", "h1"]);
    assert_eq!(dst.export_backup().await.unwrap(), json);
}

#[tokio::test]
async fn import_unknown_version_changes_nothing() {
    let db = Db::open_in_memory().unwrap();
    db.save_entities(all_kinds()).await.unwrap();
    let before = db.load_workspace().await.unwrap();
    for bad in [r#"{"version":2}"#, r#"{"collections":[]}"#, "nope"] {
        assert!(db.import_backup(bad.into()).await.is_err());
    }
    assert_eq!(db.load_workspace().await.unwrap(), before);
}

#[test]
fn newer_schema_version_refuses_with_clear_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectisapi.db");
    drop(Db::open(&path).unwrap());
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute("UPDATE schema_version SET version = 999", [])
            .unwrap();
        c.execute("INSERT INTO settings VALUES ('keep','1')", [])
            .unwrap();
    }
    let err = Db::open(&path).err().expect("must refuse");
    assert!(
        err.message.contains("999") && err.message.contains("newer"),
        "{}",
        err.message
    );
    let c = rusqlite::Connection::open(&path).unwrap();
    let v: u32 = c
        .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 999);
    let n: u32 = c
        .query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    let corrupt = std::fs::read_dir(dir.path())
        .unwrap()
        .any(|e| e.unwrap().file_name().to_string_lossy().contains("corrupt"));
    assert!(!corrupt);
}

#[tokio::test]
async fn corrupt_db_file_is_moved_aside_and_fresh_db_created() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectisapi.db");
    std::fs::write(
        &path,
        b"this is definitely not a sqlite database, just text padding".repeat(20),
    )
    .unwrap();
    let db = Db::open(&path).unwrap();
    assert!(db.load_workspace().await.unwrap().collections.is_empty());
    let moved: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("vectisapi.db.corrupt-"))
        .collect();
    assert_eq!(moved.len(), 1, "{moved:?}");
}

#[tokio::test]
async fn settings_missing_or_invalid_fall_back_to_default() {
    let db = Db::open_in_memory().unwrap();
    assert_eq!(
        db.load_workspace().await.unwrap().settings,
        Default::default()
    );
    db.save_entities(vec![EntityOp::SetSettings {
        json: "\"garbage\"".into(),
    }])
    .await
    .unwrap();
    assert_eq!(
        db.load_workspace().await.unwrap().settings,
        Default::default()
    );
}
