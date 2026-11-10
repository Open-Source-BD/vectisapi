//! App state shared by all commands: the core engine objects wired together, plus the cookie-jar
//! persister and the close-flow handshake.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tokio::sync::oneshot;
use vectis_core::cookies::CookieJar;
use vectis_core::db::{Db, EntityOp, WorkspaceSnapshot};
use vectis_core::error::CoreError;
use vectis_core::http::{ClientPool, HttpEngine, ResponseStore};
use vectis_core::realtime::RtRegistry;
use vectis_core::settings::Settings;

/// Delay between a cookie-changing action and the jar being written to the DB.
pub const JAR_PERSIST_DEBOUNCE: Duration = Duration::from_secs(1);

pub struct AppState {
    pub db: Arc<Db>,
    pub pool: ClientPool,
    pub store: Arc<ResponseStore>,
    pub jar: Arc<CookieJar>,
    pub engine: HttpEngine,
    pub rt: RtRegistry,
    pub settings: RwLock<Settings>,
    pub jar_persister: Arc<JarPersister>,
    /// Folder holding `vectisapi.db`, opened by `open_data_dir`.
    pub data_dir: PathBuf,
    /// Close-flow progress: `RUNNING` → `SHUTTING_DOWN` → `SHUT_DOWN`.
    shutdown_phase: AtomicU8,
    /// Completed by the `flush_done` command while the close flow waits for the frontend.
    pub flush_waiter: Mutex<Option<oneshot::Sender<()>>>,
}

impl AppState {
    /// Wires the core objects from the stored settings and cookie jar in `snapshot`.
    pub fn new(db: Db, snapshot: &WorkspaceSnapshot, data_dir: PathBuf) -> Self {
        let db = Arc::new(db);
        let settings = snapshot.settings.clone();
        let jar = Arc::new(
            snapshot
                .cookies_json
                .as_deref()
                .map(CookieJar::load_json)
                .unwrap_or_default(),
        );
        let pool = ClientPool::new(&settings);
        let store = Arc::new(ResponseStore::new(settings.response_store_cap_bytes));
        let engine = HttpEngine::new(pool.clone(), store.clone(), jar.clone());
        let rt = RtRegistry::new(jar.clone(), pool.clone());
        let jar_persister = Arc::new(JarPersister {
            jar: jar.clone(),
            db: db.clone(),
            scheduled: AtomicBool::new(false),
        });
        Self {
            db,
            pool,
            store,
            jar,
            engine,
            rt,
            settings: RwLock::new(settings),
            jar_persister,
            data_dir,
            shutdown_phase: AtomicU8::new(RUNNING),
            flush_waiter: Mutex::new(None),
        }
    }

    /// Makes `settings` current for the engine and the response store (not persisted here).
    pub fn apply_settings(&self, settings: Settings) {
        self.pool.update(&settings);
        self.store.set_cap(settings.response_store_cap_bytes);
        *self.settings.write() = settings;
    }
}

const RUNNING: u8 = 0;
const SHUTTING_DOWN: u8 = 1;
const SHUT_DOWN: u8 = 2;

/// What a close/exit request should do, from [`AppState::request_shutdown`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownRequest {
    /// First request: hold the close and run the shutdown flow.
    Start,
    /// The flow is already running: keep holding the close.
    Pending,
    /// The flow finished: let the close/exit through.
    Allow,
}

impl AppState {
    pub fn request_shutdown(&self) -> ShutdownRequest {
        match self.shutdown_phase.compare_exchange(
            RUNNING,
            SHUTTING_DOWN,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => ShutdownRequest::Start,
            Err(SHUTTING_DOWN) => ShutdownRequest::Pending,
            Err(_) => ShutdownRequest::Allow,
        }
    }

    pub fn mark_shut_down(&self) {
        self.shutdown_phase.store(SHUT_DOWN, Ordering::Release);
    }
}

/// Writes the cookie jar to the DB (`EntityOp::SetCookies`), coalescing bursts of changes.
pub struct JarPersister {
    jar: Arc<CookieJar>,
    db: Arc<Db>,
    scheduled: AtomicBool,
}

impl JarPersister {
    /// Writes the jar `JAR_PERSIST_DEBOUNCE` from now unless a write is already pending (that
    /// write picks up this change too). Never panics; safe to call from a realtime sink.
    pub fn schedule(self: &Arc<Self>) {
        if self.scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(JAR_PERSIST_DEBOUNCE).await;
            // Cleared before the snapshot is taken: a change made during the write schedules
            // another one instead of being lost.
            this.scheduled.store(false, Ordering::Release);
            if let Err(err) = this.write().await {
                eprintln!("vectisapi: saving cookies failed: {}", err.message);
            }
        });
    }

    /// Writes the jar now (used on close).
    pub async fn write(&self) -> Result<(), CoreError> {
        self.db
            .save_entities(vec![EntityOp::SetCookies {
                json: self.jar.to_json(),
            }])
            .await
    }
}
