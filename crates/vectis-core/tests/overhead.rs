//! Per-request engine overhead vs a bare reqwest client, against a local axum server.
//! Release only (`cargo test --release -p vectis-core --test overhead -- --nocapture`); the numbers
//! are recorded in docs/perf.md.

#[path = "support/server.rs"]
#[allow(dead_code)] // only the plain-HTTP server is used here
mod server;

use std::sync::Arc;
use std::time::{Duration, Instant};

use vectis_core::cookies::CookieJar;
use vectis_core::http::{BodySpec, ClientPool, HttpEngine, HttpRequestSpec, ResponseStore};
use vectis_core::settings::Settings;

const RUNS: usize = 100;
const WARMUP: usize = 20;

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(debug_assertions, ignore = "timing only meaningful in release")]
async fn engine_overhead_vs_raw_reqwest_under_5ms() {
    let base = server::spawn().await;
    let url = format!("{base}/json");

    let settings = Settings::default();
    let pool = ClientPool::new(&settings);
    let store = Arc::new(ResponseStore::new(settings.response_store_cap_bytes));
    let engine = HttpEngine::new(pool, store, Arc::new(CookieJar::new()));
    let raw = reqwest::Client::builder().build().unwrap();

    let mut n = 0u64;
    let mut send_engine = || {
        n += 1;
        engine.send(HttpRequestSpec {
            request_id: format!("bench-{n}"),
            method: "GET".into(),
            url: url.clone(),
            headers: vec![],
            body: BodySpec::None,
            timeout_ms: None,
        })
    };

    for _ in 0..WARMUP {
        send_engine().await.unwrap();
        raw.get(&url).send().await.unwrap().bytes().await.unwrap();
    }

    // Interleave so both see the same server/OS conditions.
    let (mut eng, mut base_t) = (Vec::with_capacity(RUNS), Vec::with_capacity(RUNS));
    for _ in 0..RUNS {
        let t = Instant::now();
        let (meta, _) = send_engine().await.unwrap();
        eng.push(t.elapsed());
        assert_eq!(meta.status, 200);

        let t = Instant::now();
        let body = raw.get(&url).send().await.unwrap().bytes().await.unwrap();
        base_t.push(t.elapsed());
        assert!(!body.is_empty());
    }

    let (e, r) = (median(eng), median(base_t));
    let overhead = e.saturating_sub(r);
    println!("engine median {e:?}, raw reqwest median {r:?}, overhead {overhead:?} (n={RUNS})");
    assert!(overhead < Duration::from_millis(5), "overhead {overhead:?}");
}
