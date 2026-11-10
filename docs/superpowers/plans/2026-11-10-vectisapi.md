# VectisAPI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port next-postman into VectisAPI, an offline Tauri 2 desktop API client with a Rust core, identical UI, and SQLite storage.

**Architecture:** The React UI from next-postman (commit `ae84135`) is copied verbatim into a Vite app. Every browser/Next.js network and storage path is replaced by Tauri commands backed by a pure-Rust crate `vectis-core` (reqwest HTTP engine, tokio-tungstenite WS, SSE, cookie_store jar, rusqlite DB on its own thread). `src-tauri` is a thin command layer. Large bodies stay in Rust; the UI receives a 2 MB prefix as raw bytes.

**Tech Stack:** Tauri 2.12.x, Rust 1.96 (MSRV 1.90), tokio, reqwest 0.13 (rustls), tokio-tungstenite, cookie_store, rusqlite (bundled, FTS5), axum (tests only), Vite + React 19 + TypeScript + Zustand 5, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-vectisapi-design.md` (read it before any task).

**Source app:** `~/shaon/next-postman` (read-only). Paths below written `NP:src/...` refer to it.

## Global Constraints

- UI fidelity: copy markup, class names and CSS unchanged. Only allowed visible changes: WorkspaceChip → "Settings" chip in the same spot; bot-wall / "Retry from browser" UI removed; timing popover on response meta; "Load full body" control for truncated bodies; cookie path/expiry hint in CookiesModal.
- Zero external network requests from the app itself. Fonts and icons bundled.
- Performance targets: cold start < 1 s (mac/win); app overhead per request < 5 ms; 50 MB body → body view first paint < 300 ms, UI never blocks; history search over 10k < 50 ms; idle RAM < 150 MB; installer < 15 MB.
- Inline response body prefix: **2 MB**. ResponseStore cap default **512 MB** (LRU by bytes).
- Timeout default **30 s** (0 = none). Redirects follow by default, max **10**. TLS verify default on. Default User-Agent `VectisAPI/<version>` unless the request sets one.
- History: one entry per method+URL (repeat send replaces and moves to top); default cap **1,000**, configurable **50–10,000**.
- Persistence: per-entity writes, debounced **300 ms**, flushed on window close. SQLite WAL, `synchronous=NORMAL`, DB file `vectisapi.db` in OS app-data dir.
- Script timeout default **5 s**; scripts run in a Web Worker.
- Realtime log cap: **5,000 messages / 20 MB** per connection, memory only.
- Cookies: RFC 6265 via `cookie_store`; the jar's cookies are attached unless the request has its own `Cookie` header.
- Release profile: `lto = "fat"`, `codegen-units = 1`, `opt-level = 3`, `strip = true`, `panic = "abort"`.
- `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` clean; `npm run typecheck`, `npm run lint`, `npm test` green after every task.
- License MIT; keep next-postman's copyright line in LICENSE.
- Commit messages: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Binary / non-UTF-8 bodies** (images, protobuf, gzip served without Content-Encoding): UI shows lossy text with correct `size`, Download writes the exact bytes. → Task 3 test `binary_body_roundtrip_exact_bytes`.
2. **Unresolved `{{var}}` or garbage URL** (`{{base}}/x`, `http://`, spaces): a clean `invalid_url` error in the response pane, never a panic or hung spinner. → Task 2 test `invalid_url_is_error_kind`, Task 8 test `unresolved var url yields error response`.
3. **Endless / huge body on an HTTP tab** (server streams forever, or a 2 GB file): user Cancel works mid-body; a body exceeding the store cap aborts with `body_too_large` instead of eating RAM. → Task 3 test `body_over_cap_errors`, Task 2 test `cancel_mid_body`.
4. **App quit or crash right after an edit**: the edit survives a normal quit (flush) and at most 300 ms of edits are lost on a crash; a corrupted/older DB never bricks startup. → Task 5 test `reopen_after_write_persists`, Task 10 test `flush on close writes pending entities`.
5. **Duplicate response headers** (multiple `Set-Cookie`, `Link`, `Vary`): all values kept in order in `headerList`; the legacy `headers` record joins values with `, ` (and `\n` for set-cookie) so the Headers tab shows every value. → Task 2 test `duplicate_response_headers_preserved`.

---

## File Structure (target repo `~/shaon/vectisapi`)

```
Cargo.toml                       # workspace: crates/vectis-core, src-tauri
crates/vectis-core/
  src/lib.rs                     # re-exports
  src/error.rs                   # CoreError, ErrorKind
  src/http/spec.rs               # HttpRequestSpec, BodySpec, ResponseMeta, Timing
  src/http/client.rs             # ClientPool (settings → reqwest::Client)
  src/http/engine.rs             # send(), cancellation registry
  src/http/store.rs              # ResponseStore (LRU by bytes)
  src/cookies.rs                 # CookieJar wrapper over cookie_store
  src/realtime/ws.rs             # WebSocket connect/send/close
  src/realtime/sse.rs            # SSE parser + stream
  src/realtime/mod.rs            # RtEvent, ConnRegistry
  src/db/mod.rs                  # Db handle (dedicated thread, job channel)
  src/db/migrations.rs           # schema versions
  src/db/repo.rs                 # entity load/save, history, settings, backup
  src/settings.rs                # Settings struct + defaults
  tests/http_engine.rs           # axum test server integration tests
  tests/realtime.rs
  tests/db.rs
src-tauri/
  Cargo.toml, tauri.conf.json, build.rs, capabilities/default.json
  src/main.rs, src/lib.rs        # builder, state, plugin registration
  src/commands/{http,realtime,db,cookies,settings,files}.rs
index.html
vite.config.ts, tsconfig.json, vitest.config.ts, eslint.config.mjs, package.json
src/main.tsx                     # replaces NP:src/app/page.tsx + layout.tsx
src/app/*.css                    # verbatim from NP
src/components/ui/*              # verbatim from NP
src/features/api-client/**       # from NP, modified per tasks below
src/features/api-client/lib/native/  # NEW: tauri bridge (invoke wrappers, decoders)
src/features/api-client/lib/scriptWorker.ts, scriptHost.ts  # NEW
.github/workflows/ci.yml, release.yml
```

---

### Task 1: Scaffold Tauri + Vite and port the UI verbatim

**Files:**
- Create: `Cargo.toml`, `src-tauri/**`, `crates/vectis-core/{Cargo.toml,src/lib.rs}`, `index.html`, `vite.config.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `src/main.tsx`, `LICENSE`, `README.md`
- Copy verbatim: `NP:src/app/*.css` → `src/app/`, `NP:src/components/**` → `src/components/`, `NP:src/features/**` → `src/features/`, `NP:src/types/**` → `src/types/`, `NP:.prettierrc`
- Do not copy: `NP:src/app/api/**`, `NP:src/app/layout.tsx`, `NP:src/app/page.tsx`, storybook, husky, `next.config.mjs`

**Interfaces:**
- Produces: `npm run tauri dev` opens the app; `@/` alias → `src/`; `window.__TAURI_INTERNALS__` present at runtime.

- [ ] **Step 1:** `npm create tauri-app@latest` equivalent by hand: Vite React-TS frontend + `src-tauri`, identifier `dev.vectisapi.app`, productName `VectisAPI`, window title `VectisAPI`, 1280×800 min 960×600. Workspace `Cargo.toml` with members `crates/vectis-core`, `src-tauri` and the release profile from Global Constraints.
- [ ] **Step 2:** Copy the NP files listed above. `src/main.tsx` renders `<ApiClient />` inside `React.StrictMode`, imports `./app/globals.css` and the fonts. Remove `'use client'` directives (harmless but drop them). Replace `next/font` with `@fontsource/roboto` (400, 500, 700), `@fontsource/fira-code` (400, 500) and the `material-symbols` package (outlined). In `index.html`/CSS set `--font-roboto: 'Roboto'` and `--font-fira-code: 'Fira Code'` on `:root` so `globals.css` is unchanged. `index.html` title `VectisAPI`.
- [ ] **Step 3:** Port `vitest.config.ts` (jsdom), `tsconfig.json` paths, ESLint (drop `eslint-config-next`, use `typescript-eslint` + `eslint-plugin-react-hooks`). Copy all NP `*.test.ts`.
- [ ] **Step 4:** Run `npm run typecheck && npm test`. Expected: PASS (all copied tests still pass; network-dependent code is untouched so far).
- [ ] **Step 5:** Set CSP in `tauri.conf.json`: `default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src ipc: http://ipc.localhost`. Run `npm run tauri dev`; app window shows the empty state identical to `NP` `npm run dev` (compare by screenshot). Confirm in devtools Network: zero external requests.
- [ ] **Step 6:** Commit `chore: scaffold tauri app and port next-postman ui`.

### Task 2: HTTP engine in `vectis-core`

**Files:**
- Create: `crates/vectis-core/src/{error.rs,settings.rs}`, `src/http/{mod.rs,spec.rs,client.rs,engine.rs}`, `tests/http_engine.rs`, `tests/support/server.rs`

**Interfaces:**
- Produces:
  ```rust
  pub enum ErrorKind { InvalidUrl, ConnectionRefused, Dns, Timeout, ConnectionReset, Tls, Cancelled, BodyTooLarge, Io, Other }
  pub struct CoreError { pub kind: ErrorKind, pub message: String }   // Serialize as {kind:"connection_refused", message}
  pub struct Settings { pub timeout_ms: u64, pub follow_redirects: bool, pub max_redirects: usize,
      pub verify_tls: bool, pub proxy_url: Option<String>, pub user_agent: Option<String>,
      pub response_store_cap_bytes: u64, pub history_limit: u32, pub theme: Option<String> }  // Default = spec values
  pub struct HttpRequestSpec { pub request_id: String, pub method: String, pub url: String,
      pub headers: Vec<(String, String)>, pub body: BodySpec, pub timeout_ms: Option<u64> }
  pub enum BodySpec { None, Text(String), Base64(String), UrlEncoded(Vec<(String,String)>),
      Multipart(Vec<MultipartPart>) }       // serde tag = "type", content = "value"
  pub struct MultipartPart { pub name: String, pub value: PartValue }
  pub enum PartValue { Text(String), File { path: String, file_name: Option<String>, content_type: Option<String> } }
  pub struct Timing { pub total_ms: f64, pub ttfb_ms: f64 }
  pub struct ResponseMeta { pub response_id: String, pub status: u16, pub status_text: String,
      pub http_version: String, pub headers: Vec<(String,String)>, pub remote_addr: Option<String>,
      pub final_url: String, pub size: u64, pub timing: Timing, pub truncated: bool }
  pub struct ClientPool;  impl ClientPool { pub fn new(&Settings) -> Self; pub fn update(&self, &Settings); pub fn client(&self) -> reqwest::Client }
  pub struct HttpEngine;  impl HttpEngine {
      pub fn new(pool: ClientPool, store: Arc<ResponseStore>, jar: Arc<CookieJar>) -> Self;
      pub async fn send(&self, spec: HttpRequestSpec) -> Result<(ResponseMeta, bytes::Bytes /*prefix ≤2MB*/), CoreError>;
      pub fn cancel(&self, request_id: &str) -> bool; }
  ```
  `ResponseStore` and `CookieJar` come from Tasks 3 and 4; in this task use the minimal stubs defined there (implement Tasks 2–4 in order, stubs are fine until then — or do Task 3/4's type definitions first).

- [ ] **Step 1: Write failing tests** in `tests/http_engine.rs` using an axum server on `127.0.0.1:0`:
  - `get_returns_status_headers_body` — GET `/json` → status 200, `headers` contains `("content-type","application/json")`, body bytes equal fixture, `timing.ttfb_ms <= timing.total_ms`.
  - `request_headers_sent_in_order_with_duplicates` — send `[("X-A","1"),("X-A","2"),("Host","example.test"),("Cookie","a=b")]` to `/echo-headers`; server sees both X-A values in order, Host `example.test`, Cookie `a=b`.
  - `duplicate_response_headers_preserved` — `/multi-set-cookie` returns 3 `Set-Cookie` → `meta.headers` has 3 entries in order.
  - `bodies_text_urlencoded_base64_multipart_file` — each BodySpec variant echoed back exactly; multipart file part streams a temp file of 5 MB and server receives identical bytes and the given file name.
  - `redirects_followed_and_capped` — chain of 3 → final_url is last hop; chain of 11 → error kind `Other` with message containing "redirect".
  - `decompresses_gzip_brotli_zstd` — size equals decompressed length.
  - `timeout_kind` — `/sleep/2000` with `timeout_ms: Some(200)` → `ErrorKind::Timeout`.
  - `cancel_mid_body` — `/slow-stream` sends 1 KB/100 ms forever; `cancel(id)` after 300 ms → `ErrorKind::Cancelled` within 100 ms.
  - `connection_refused_kind` (closed port), `dns_kind` (`http://nonexistent.invalid`), `invalid_url_is_error_kind` (`"http://"` and `"{{base}}/x"`).
  - `self_signed_tls_fails_then_passes_with_verify_off` — rustls test server with self-signed cert: `Tls` kind; after `pool.update(verify_tls=false)` → 200.
  - `default_user_agent_unless_set` — UA is `VectisAPI/<CARGO_PKG_VERSION>`; explicit header wins.
- [ ] **Step 2:** `cargo test -p vectis-core --test http_engine` → FAIL (types missing).
- [ ] **Step 3:** Implement. reqwest 0.13 features: `rustls`, `http2`, `gzip`, `brotli`, `deflate`, `zstd`, `stream`, `multipart`, `socks`; native roots via `rustls-platform-verifier`. Disable reqwest's own cookie store and redirect-following is set from Settings (`redirect::Policy::limited(max)` / `none`). Build headers with `HeaderMap::append` to keep duplicates/order. Multipart files via `reqwest::multipart::Part::stream` over `tokio::fs::File`. Timing: `Instant` at send, `ttfb` when `send()` resolves, `total` after body end. Read the body with `bytes_stream()`, pushing chunks into the store (Task 3); cancellation via a `DashMap<String, CancellationToken>` (`tokio_util`) and `tokio::select!`. Error kind mapping: `is_timeout`→Timeout, `is_connect` + io `ConnectionRefused`→ConnectionRefused, hyper DNS error→Dns, rustls error in source chain→Tls, `ConnectionReset`→ConnectionReset, URL parse→InvalidUrl. `status_text` from `canonical_reason()` or "".
- [ ] **Step 4:** Tests pass; clippy clean.
- [ ] **Step 5:** Commit `feat(core): http engine with cancellation, timing and error kinds`.

### Task 3: ResponseStore (large bodies)

**Files:**
- Create: `crates/vectis-core/src/http/store.rs`, tests in `tests/http_engine.rs` (append)

**Interfaces:**
- Produces:
  ```rust
  pub struct ResponseStore; impl ResponseStore {
      pub fn new(cap_bytes: u64) -> Self;
      pub fn begin(&self, response_id: &str) -> BodyWriter;      // append chunks; errors BodyTooLarge if one body > cap
      pub fn get_range(&self, response_id: &str, start: u64, end: Option<u64>) -> Option<bytes::Bytes>;
      pub fn len(&self, response_id: &str) -> Option<u64>;
      pub fn save_to_file(&self, response_id: &str, path: &Path) -> Result<(), CoreError>;
      pub fn set_cap(&self, cap_bytes: u64); }
  pub const INLINE_PREFIX_BYTES: usize = 2 * 1024 * 1024;
  ```
- [ ] **Step 1: Failing tests:** `prefix_is_2mb_and_truncated_flag` (5 MB body → prefix len 2,097,152, `truncated == true`, `size == 5 MB`; 1 KB body → `truncated == false`); `get_range_returns_exact_slice`; `binary_body_roundtrip_exact_bytes` (random 3 MB incl. invalid UTF-8 → `save_to_file` bytes identical); `lru_evicts_oldest_when_over_cap` (cap 10 MB, store 4×4 MB → first id `None`); `body_over_cap_errors` (cap 1 MB, 2 MB response → `ErrorKind::BodyTooLarge`, memory released).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `parking_lot::Mutex<LruIndex>` holding `Vec<Bytes>` chunks per id (no copy on append; concatenate lazily for ranges). **Step 4:** PASS. **Step 5:** Commit `feat(core): response store with 2MB inline prefix and LRU cap`.

### Task 4: Cookie jar (RFC 6265)

**Files:**
- Create: `crates/vectis-core/src/cookies.rs`, `tests/cookies.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct CookieView { pub domain: String, pub path: String, pub name: String, pub value: String,
      pub expires: Option<i64 /*unix s*/>, pub secure: bool, pub http_only: bool }
  pub struct CookieJar; impl CookieJar {
      pub fn new() -> Self; pub fn load_json(s: &str) -> Self; pub fn to_json(&self) -> String;
      pub fn header_for(&self, url: &Url) -> Option<String>;
      pub fn store_response(&self, url: &Url, set_cookie_values: &[String]);
      pub fn list(&self) -> Vec<CookieView>;
      pub fn delete(&self, domain: &str, path: &str, name: &str); pub fn clear_domain(&self, domain: &str); pub fn clear(&self); }
  ```
- [ ] **Step 1: Failing tests:** `domain_cookie_sent_to_subdomain`; `host_only_cookie_not_sent_to_subdomain`; `path_matching`; `expired_not_sent`; `secure_only_on_https`; `json_roundtrip`; and in `http_engine.rs`: `jar_attached_unless_explicit_cookie_header`, `set_cookie_captured_after_redirect_hops` (each hop's Set-Cookie stored against that hop's URL — implement redirects manually in engine when jar is on, or capture from final response only and document; the test pins "final response captured" minimum).
- [ ] **Step 2–4:** Run/implement (wrap `cookie_store::CookieStore` in `RwLock`; jar attached in `HttpEngine::send` when no header named `cookie` in spec)/pass.
- [ ] **Step 5:** Commit `feat(core): rfc6265 cookie jar`.

### Task 5: SQLite storage

**Files:**
- Create: `crates/vectis-core/src/db/{mod.rs,migrations.rs,repo.rs}`, `tests/db.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct Db; impl Db {                     // owns rusqlite::Connection on a dedicated std::thread; jobs via crossbeam channel; async API via oneshot
      pub fn open(path: &Path) -> Result<Db, CoreError>; pub fn open_in_memory() -> Result<Db, CoreError>;
      pub async fn load_workspace(&self) -> Result<WorkspaceSnapshot, CoreError>;
      pub async fn save_entities(&self, ops: Vec<EntityOp>) -> Result<(), CoreError>;   // one transaction
      pub async fn add_history(&self, item_json: String, method: String, url: String, status: u16, duration_ms: f64, ts: i64, limit: u32) -> Result<(), CoreError>;
      pub async fn search_history(&self, q: String, limit: u32) -> Result<Vec<String /*item json*/>, CoreError>;
      pub async fn export_backup(&self) -> Result<String, CoreError>;  pub async fn import_backup(&self, json: String) -> Result<(), CoreError>; }
  pub struct WorkspaceSnapshot { pub collections: Vec<serde_json::Value>, pub environments: Vec<serde_json::Value>,
      pub globals: serde_json::Value, pub active_env_id: Option<String>, pub history: Vec<serde_json::Value>,
      pub tabs: Vec<serde_json::Value>, pub ui_state: serde_json::Map<String, serde_json::Value>,
      pub cookies_json: Option<String>, pub settings: Settings }     // camelCase serde
  pub enum EntityOp {   // serde tag="op", camelCase
      UpsertCollection{id,sort:i64,json}, DeleteCollection{id}, UpsertEnvironment{id,sort:i64,json}, DeleteEnvironment{id},
      SetGlobals{json}, SetActiveEnv{id:Option<String>}, ReplaceTabs{tabs:Vec<(String,String)>},
      SetUiState{key,json}, SetCookies{json}, SetSettings{json}, ClearHistory, DeleteHistory{id} }
  ```
  Tables exactly as spec §6.5 plus `schema_version`. Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- [ ] **Step 1: Failing tests:** `migrations_idempotent_and_versioned`; `reopen_after_write_persists` (file DB, write each entity kind, drop, reopen, `load_workspace` equal); `history_dedupes_method_url_and_moves_to_top`; `history_cap_prunes_oldest` (limit 50 → 51st add leaves 50); `history_search_fts_10k_under_50ms` (insert 10,000, `search_history("users")` < 50 ms in release — mark `#[ignore]` in debug, run with `--release -- --ignored` in CI); `save_entities_is_atomic` (op list with a bad op → none applied); `backup_roundtrip`; `newer_schema_version_refuses_with_clear_error` (no data destroyed); `corrupt_db_file_is_moved_aside_and_fresh_db_created` (file renamed `vectisapi.db.corrupt-<ts>`).
- [ ] **Step 2–4:** Run/implement (rusqlite features `bundled`, FTS5 via `bundled` build — enable `SQLITE_ENABLE_FTS5` if needed through `libsqlite3-sys` `bundled-full` or features), pass.
- [ ] **Step 5:** Commit `feat(core): sqlite storage on dedicated thread`.

### Task 6: Realtime (WebSocket + SSE) in core

**Files:**
- Create: `crates/vectis-core/src/realtime/{mod.rs,ws.rs,sse.rs}`, `tests/realtime.rs`

**Interfaces:**
- Produces:
  ```rust
  pub enum RtEvent {   // serde tag="type", camelCase
      Connecting, Open, Message{ text: String, bytes: u64, binary: bool }, SseEvent{ event: String, data: String, id: Option<String> },
      Closed{ code: Option<u16>, reason: String }, Error{ message: String } }
  pub struct RtRegistry; impl RtRegistry {
      pub fn new(jar: Arc<CookieJar>, pool: ClientPool) -> Self;
      pub async fn open_ws(&self, conn_id: String, url: String, headers: Vec<(String,String)>, protocols: Vec<String>, sink: impl Fn(RtEvent)+Send+Sync+'static) -> Result<(), CoreError>;
      pub async fn send_ws(&self, conn_id: &str, text: String) -> Result<(), CoreError>;
      pub async fn open_sse(&self, conn_id: String, spec: HttpRequestSpec, last_event_id: Option<String>, sink: impl Fn(RtEvent)+Send+Sync+'static) -> Result<(), CoreError>;
      pub fn close(&self, conn_id: &str); pub fn close_all(&self); }
  pub struct SseParser; impl SseParser { pub fn new() -> Self; pub fn push(&mut self, chunk: &[u8]) -> Vec<SseFrame>; }
  ```
  Opening an already-open `conn_id` is a no-op (idempotent, like NP `openWebSocket`). Binary WS frames: `text` = `[binary N bytes]`, `binary: true` (matches NP display).
- [ ] **Step 1: Failing tests:** port every case from `NP:src/features/api-client/lib/parseSse.test.ts` to `sse_parser_*` Rust tests (multi-line data, `event`, `id`, `retry`, comments, CRLF, chunk splits mid-line, UTF-8 split across chunks); `ws_echo_with_custom_headers_and_subprotocol` (axum WS server asserts `Authorization` header and `Sec-WebSocket-Protocol`); `ws_binary_frame_reported`; `ws_close_code_reason`; `ws_open_idempotent`; `sse_stream_events_and_last_event_id_sent`; `sse_non_2xx_is_error_event`; `close_stops_events`.
- [ ] **Step 2–4:** Run/implement (tokio-tungstenite with `rustls-tls-native-roots`; build `http::Request` via `IntoClientRequest` and append headers; WS honors `verify_tls` by building a rustls `Connector`)/pass.
- [ ] **Step 5:** Commit `feat(core): websocket and sse clients`.

### Task 7: Tauri command layer

**Files:**
- Create: `src-tauri/src/commands/{http.rs,realtime.rs,db.rs,cookies.rs,settings.rs,files.rs}`, `src-tauri/src/state.rs`; Modify: `src-tauri/src/lib.rs`, `capabilities/default.json`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces (command names are the TS contract):
  - `send_request(spec: HttpRequestSpec) -> tauri::ipc::Response` — binary: `[u32 LE meta_len][meta JSON utf-8][prefix bytes]`. On error: `Err(CoreError)` (serialized `{kind,message}`).
  - `cancel_request(request_id: String) -> bool`
  - `get_response_body(response_id: String, start: u64, end: Option<u64>) -> tauri::ipc::Response` (raw bytes; error if evicted: kind `Other`, message `"Response body no longer available"`).
  - `save_response_body(response_id: String, path: String) -> ()`
  - `rt_open_ws(conn_id, url, headers, protocols, on_event: Channel<RtEvent>)`, `rt_open_sse(conn_id, spec, last_event_id, on_event: Channel<RtEvent>)`, `rt_send(conn_id, text)`, `rt_close(conn_id)`
  - `load_workspace() -> WorkspaceSnapshot`, `save_entities(ops: Vec<EntityOp>)`, `add_history(...)`, `search_history(q, limit)`, `export_backup(path)`, `import_backup(path)`
  - `cookies_list() -> Vec<CookieView>`, `cookies_delete(domain,path,name)`, `cookies_clear_domain(domain)`, `cookies_clear()`
  - `get_settings() -> Settings`, `set_settings(settings: Settings)` (persists + `ClientPool::update` + `ResponseStore::set_cap`)
  - `open_data_dir()`
  - Jar persisted: after each `send_request`/WS open, schedule `SetCookies` (debounced 1 s in Rust).
- [ ] **Step 1:** Register plugins `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-fs` (scope: only user-picked paths), `tauri-plugin-window-state`. App state built in `setup()`: DB at `app_data_dir()/vectisapi.db`.
- [ ] **Step 2: Failing test** `src-tauri/src/commands/http.rs` `#[cfg(test)]` using `tauri::test::mock_builder()`: `send_request_binary_frame_decodes` (meta_len prefix + JSON + body against a local axum server).
- [ ] **Step 3–4:** Implement, pass. On window `CloseRequested`: emit `vectis://flush` to the frontend, wait up to 1 s for `flush_done` command, `RtRegistry::close_all()`, then close.
- [ ] **Step 5:** Commit `feat(tauri): command layer`.

### Task 8: Frontend native transport (replace proxy pipeline)

**Files:**
- Create: `src/features/api-client/lib/native/{invoke.ts,buildRequestSpec.ts,decodeResponse.ts,buildRequestSpec.test.ts,decodeResponse.test.ts}`
- Modify: `lib/executeRequest.ts`, `lib/sendActive.ts`, `lib/collectionRunner.ts`, `types/http.ts`, `types/tab.ts`, `store/slices/tabsSlice.ts` (line ~208 cookie usage), `store/slices/collectionsSlice.ts` (cookieJar), `components/response/ResponsePane.tsx` (remove challenge panel lines ~170–210), `components/modals/CookiesModal.tsx`
- Delete: `lib/proxyClient.ts(+test)`, `lib/botWall.ts(+test)`, `lib/buildProxyRequest.ts(+test, after porting its cases)`, `lib/cookies.ts` jar functions (keep `parseSetCookie` only if still used), `ChallengeInfo` type

**Interfaces:**
- Produces:
  ```ts
  // types/http.ts additions
  interface ResponseData { /* existing fields kept */ responseId?: string; truncated?: boolean;
    headerList?: [string, string][]; httpVersion?: string; timing?: { totalMs: number; ttfbMs: number }; finalUrl?: string; errorKind?: string }
  // native/buildRequestSpec.ts
  export function buildRequestSpec(tab: TabState, vars: EnvVar[], requestId: string, timeoutMs?: number): HttpRequestSpec
  // native/invoke.ts
  export async function sendRequest(spec: HttpRequestSpec): Promise<{ meta: ResponseMeta; prefix: Uint8Array }>
  export function cancelRequest(id: string): Promise<boolean>
  export function getResponseBody(id: string, start?: number, end?: number): Promise<Uint8Array>
  // native/decodeResponse.ts
  export function decodeSendFrame(buf: ArrayBuffer): { meta: ResponseMeta; prefix: Uint8Array }
  export function toResponseData(meta: ResponseMeta, prefix: Uint8Array): Omit<ResponseData, 'testResults'>
  ```
  `ResponseData.headers` stays `Record<string,string>`: values joined with `, `, except `set-cookie` joined with `\n`. `rawText` = `TextDecoder('utf-8', {fatal:false})` of prefix. `timeTaken` = `Math.round(timing.totalMs)`. `size` = meta.size. `ok` = 200–299. `transport` field removed.
  `executeRequest(tab, seedVars, opts)` keeps its signature minus `directFallback`/`forceDirect`/`cookieHeader`; `ExecuteResult` loses `challenge`. External `signal` abort → `cancelRequest(requestId)`. Timeout passed into the spec (Rust enforces it); default from settings.
  Error response mapping (keep NP's shape): `{ ok:false, status:0, statusText:'Error', rawText: message, errorKind: kind }`.
- [ ] **Step 1: Failing tests:** port every assertion in `NP:lib/buildProxyRequest.test.ts` to `buildRequestSpec.test.ts` (6 auth types, params appended, env resolution, raw/json/urlencoded/graphql bodies, Content-Type defaults, formdata). New: `basic auth base64 handles unicode` (UTF-8 then base64), `headers keep duplicates in order`, `GET with body type raw sends no body` (BODY_METHODS rule preserved), `formdata file item emits File part with path`. `decodeResponse.test.ts`: `decodes frame`, `joins duplicate headers`, `set-cookie joined with newline`, `invalid utf8 prefix decodes lossily`. `executeRequest.test.ts` rewritten with `vi.mock('./native/invoke')`: `unresolved var url yields error response` (Rust returns `invalid_url` → status 0 response, no throw), `tests receive full body when truncated` (mock `getResponseBody` called once when `tab.tests` non-empty and `truncated`), `abort signal cancels`.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** Implement; delete the browser-only modules and their UI. CookiesModal reads `cookies_list` on open and calls the delete/clear commands; layout unchanged, adds `path` (when ≠ `/`) and an expiry hint using existing muted-text classes. `captureCookies` and `cookieJar` removed from store. **Step 4:** `npm test && npm run typecheck` PASS; manual: send GET to `http://localhost:<port>` and to `https://httpbin.org/anything` in `tauri dev`. **Step 5:** Commit `feat(ui): native rust transport replaces proxy`.

### Task 9: Form-data file parts by path

**Files:** Modify `types/http.ts` (`KvItem.filePath?: string; fileName?: string` — `file: File` removed), `components/tabs/BodyTab.tsx`, `components/ui/KvEditor.tsx` (file cell), `lib/native/buildRequestSpec.ts`

- [ ] **Step 1: Failing test** `KvEditor file cell shows chosen file name` and `buildRequestSpec emits PartValue.File with filePath` (vitest; dialog mocked).
- [ ] **Step 2–4:** File cell button opens `@tauri-apps/plugin-dialog` `open({ multiple:false })`, stores path + basename; same visuals as NP's file input. Persisted tabs now keep the file reference (NP dropped it). Pass.
- [ ] **Step 5:** Commit `feat(ui): form-data files sent from disk by path`.

### Task 10: SQLite-backed persistence

**Files:** Create `src/features/api-client/store/persistNative.ts`, `persistNative.test.ts`; Delete `store/persist.ts`; Modify `ApiClient.tsx` (use `usePersistence` from new file), `store/slices/historySlice.ts` (cap from settings), `components/sidebar/HistoryPanel.tsx` (search via `search_history` when query non-empty; virtualized list)

**Interfaces:**
- Consumes: `load_workspace`, `save_entities`, `add_history`, `search_history`.
- Produces: `export function usePersistence(): void` (same name as NP); `export function diffToOps(prev: StoreState, next: StoreState): EntityOp[]`; `export function flushNow(): Promise<void>`.
- [ ] **Step 1: Failing tests:** `diffToOps emits only changed collection` (reference equality like NP), `deleted environment emits DeleteEnvironment`, `tabs strip response and prevResponse`, `debounces 300ms per entity` (fake timers: 3 edits in 200 ms → 1 save_entities call), `flush on close writes pending entities` (pending op + `vectis://flush` event → save called immediately, then `flush_done`), `hydrate failure starts clean and marks hydrated`.
- [ ] **Step 2–4:** Implement. History: `addHistory` in store also calls `add_history` (not via diff). Cap = `settings.historyLimit`. Pass.
- [ ] **Step 5:** Commit `feat(ui): sqlite persistence`.

### Task 11: Script sandbox in a Web Worker

**Files:** Create `lib/scriptWorker.ts` (worker entry), `lib/scriptHost.ts`, `lib/scriptHost.test.ts`; Modify `lib/pmSandbox.ts` (unchanged logic, made importable in worker), `lib/executeRequest.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScriptRun { phase: 'pre' | 'test'; code: string; vars: Record<string,string>; iterationData?: Record<string,string>;
    response?: { code: number; status: string; body: string } }
  export interface ScriptResult { vars: Record<string,string>; setVars: [string,string][]; testResults: TestResult[]; error?: string }
  export function runScript(run: ScriptRun, timeoutMs?: number /*default 5000*/): Promise<ScriptResult>
  ```
  Worker created with `new Worker(new URL('./scriptWorker.ts', import.meta.url), { type: 'module' })`, reused; on timeout `terminate()` and recreate; result `error: 'Script timed out after 5s'`. Empty/whitespace code short-circuits without touching the worker (keeps the < 5 ms overhead target).
- [ ] **Step 1: Failing tests** (vitest with `@vitest/web-worker`): `pre-request sets var visible to request`, `pm.test results returned`, `infinite loop times out and next run works`, `script cannot access window/document` (`typeof document === 'undefined'` inside), `empty script does not spawn worker`. Keep all existing `pmSandbox.test.ts` passing.
- [ ] **Step 2–4:** Implement; `executeRequest` awaits `runScript` for both phases; `onSetVar` invoked for each `setVars`. Replace NP's `alert('Pre-request Script Error…')` in `sendActive.ts` with the error shown as the response (status 0, statusText `Script Error`) — no blocking dialogs. Pass.
- [ ] **Step 5:** Commit `feat(ui): sandboxed script worker with timeout`.

### Task 12: Realtime UI on Rust

**Files:** Modify `lib/realtimeConnection.ts` (same exported functions: `isConnected`, `openWebSocket`, `sendWebSocket`, `closeConnection`, `openSse`), its test, `components/realtime/RealtimePane.tsx` (virtualized log), store subscription closing connections for removed tab ids.

- [ ] **Step 1: Failing tests** (invoke + Channel mocked): `openWebSocket passes headers and protocols to rt_open_ws`, `events map to RtHandlers`, `stale generation ignored after reconnect`, `closing tab closes connection` (incl. NP's last-tab replacement path in `closeTab`), `log capped at 5000 messages or 20MB`.
- [ ] **Step 2–4:** `openWebSocket(tabId, url, protocols, handlers, headers?)` gains optional headers (from tab headers + auth, built with `buildRequestSpec` header logic). SSE builds an `HttpRequestSpec` and calls `rt_open_sse` with `lastEventId`. Pass.
- [ ] **Step 5:** Commit `feat(ui): realtime over rust ws/sse`.

### Task 13: Large-body UI

**Files:** Modify `components/response/ResponsePane.tsx`, `components/ui/CodeView.tsx`, `components/modals/ResponseModal.tsx`; Create `components/ui/VirtualLines.tsx` (+test)

- [ ] **Step 1: Failing tests:** `VirtualLines renders only visible rows` (100k lines → < 200 DOM rows), `truncated response shows Load full body` (label `Load full body (12.4 MB)` using `lib/format.ts` size formatter), `Download calls save_response_body with dialog path` (no JS-side blob for native responses), `pretty view of >2MB loads only after click`.
- [ ] **Step 2–4:** `CodeView` switches to `VirtualLines` above 5,000 lines, keeping the same line-number/token styling classes. Syntax highlight per visible line chunk. JSON tree for truncated responses only after "Load full body". Pass; manual check in `tauri dev` with a 50 MB JSON from a local server: first paint < 300 ms, scrolling smooth.
- [ ] **Step 5:** Commit `feat(ui): virtualized large response bodies`.

### Task 14: Settings modal, backup, next-postman migration

**Files:** Create `components/modals/SettingsModal.tsx` (+test), `lib/native/backup.ts`; Replace `components/WorkspaceChip.tsx` with `SettingsChip.tsx`; Modify `TopBar.tsx`; Keep `lib/workspaceFile.ts` (import-only), delete `lib/workspaceFs.ts`, `lib/zipWorkspace.ts` writing paths (keep zip *reading*).

- [ ] **Step 1: Failing tests:** `SettingsChip renders in TopBar with chip classes and 'Settings' label`; `SettingsModal saves timeout/redirects/verify TLS/proxy/user agent/store cap/history limit` → `set_settings` payload; `history limit clamps to 50–10000`; `import next-postman workspace zip populates collections and environments` (use NP `workspaceFile.test.ts` fixtures); `backup export then import restores everything`.
- [ ] **Step 2–4:** Modal reuses EnvModal's structure/classes. Buttons: "Export all", "Import all" (accepts `.json` backup, next-postman workspace `.zip`, or a folder), "Open data folder". Pass.
- [ ] **Step 5:** Commit `feat(ui): settings modal, backup and next-postman import`.

### Task 15: Timing popover

**Files:** Modify `ResponsePane.tsx` meta area; test in `ResponsePane.test.tsx`

- [ ] **Step 1–4:** Test `hovering time shows TTFB and total and HTTP version`; implement with existing overlay classes from `overlays.css`. Commit `feat(ui): response timing popover`.

### Task 16: Fidelity, performance, CI, release

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `e2e/*.spec.ts` (ported, with `src/test/mockTauri.ts` installing `@tauri-apps/api/mocks` `mockIPC`), `docs/perf.md`, `docs/fidelity/`; Update `README.md`

- [ ] **Step 1:** Port NP's 7 Playwright specs to run against `vite dev` with `mockIPC` (send returns a canned frame). `npm run test:e2e` PASS.
- [ ] **Step 2:** Fidelity: screenshot NP (`npm run dev`, Chromium 1280×800) and VectisAPI (`tauri dev`) for the 7 states in spec §6.1 (light + dark). Save pairs in `docs/fidelity/`. Any visible difference outside the allowed list is a bug to fix in this step.
- [ ] **Step 3:** Perf: measure and record in `docs/perf.md` on a release build: cold start, per-request overhead (local server, median of 100), 50 MB body first paint, 10k history search, idle RAM, installer size. Each must meet Global Constraints; fix or file what fails.
- [ ] **Step 4:** CI: `check` job (fmt, clippy, cargo test, typecheck, lint, vitest, e2e) on ubuntu; `build` matrix `macos-latest`, `windows-latest`, `ubuntu-22.04` with `tauri-apps/tauri-action` producing dmg / msi+nsis / AppImage+deb, unsigned. Linux deps: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`.
- [ ] **Step 5:** README: features, install, build from source, the Linux `WEBKIT_DISABLE_DMABUF_RENDERER=1` note, data location, migration from next-postman. LICENSE with both copyright lines.
- [ ] **Step 6:** Commit `chore: ci, release builds, fidelity and perf docs`.
