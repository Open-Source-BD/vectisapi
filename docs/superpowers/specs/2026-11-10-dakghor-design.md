# Dakghor — offline desktop API client (design)

Date: 2026-11-10
Status: draft for approval

## 1. Intent and why

A free, offline, cross-platform (macOS, Windows, Linux) desktop API client: a Postman alternative.

It is a port of **next-postman** (https://github.com/Open-Source-BD/next-postman, MIT, cloned at
`~/shaon/next-postman`, commit `ae84135`) into a **Tauri 2** desktop app with a **Rust** core.

Why it exists (the user's words): browser-based next-postman hits CORS problems, and Postman is paid.
Concretely, next-postman sends requests through a Next.js server route; when deployed, that server
cannot reach `localhost`/internal hosts and gets blocked by bot walls, and its browser-direct fallback
dies on CORS. WebSocket is browser-direct, so no custom headers. A native app with a Rust HTTP stack
removes every one of those limits.

The user's explicit requirements:
1. **The UI must be the same** as next-postman.
2. **Extremely fast.** Use the best Rust packages/frameworks available.
3. **Offline**, data stored in an **internal database** (not files in a folder).
4. The user delegated all other choices: "choose the best options, research when unsure."

"Dakghor" (ডাকঘর, "post office" in Bangla) is a working name; renaming is cheap.

## 2. Goals

- Feature parity with next-postman (inventory in §5), with identical look and interaction.
- Every request behaves as if sent by curl from the user's machine: localhost, LAN, self-signed
  certs (opt-in), any header incl. `Cookie`, `Host`, `User-Agent`, `Origin`; WebSocket with custom headers.
- Performance targets (release build, mid-range laptop):
  - Cold start to interactive UI: **< 1 s** on macOS/Windows.
  - App overhead on a request (UI click → bytes on wire, excluding network): **< 5 ms**.
  - A 50 MB response does not freeze the UI; first paint of the body view **< 300 ms**.
  - History/collection search over 10k items: **< 50 ms** per keystroke.
  - Idle memory **< 150 MB**; installer **< 15 MB**.
- Improvements over next-postman (§6).

## 3. Non-goals (v1)

- Cloud sync, accounts, teams, telemetry. Never.
- gRPC, GraphQL subscriptions, Socket.IO, MQTT (GraphQL-over-HTTP body stays, it exists today).
- Mock servers, API docs publishing, monitors.
- Auto-updater and code signing / notarization (structure the build so they can be added later).
- Mobile builds.
- Git-file storage (user chose an internal DB; Postman/OpenAPI export covers portability).

## 4. Anti-goals (failure even if it "works")

- UI drifts visibly from next-postman (different layout, colors, spacing, fonts, shortcuts).
- The UI thread freezes on large responses, big collections, or long WebSocket logs.
- Any network call leaves the machine except the user's own requests (fonts must be bundled, no CDN).
- Requests silently altered (headers dropped, body re-encoded, cookies leaked from elsewhere).
- User data lost on crash (DB must be durable; writes must not be "save on quit").

## 5. What next-postman has (to be preserved)

~12k lines TS. Next.js 16 App Router, React 19, Zustand 5, ~2k lines of plain CSS
(`src/app/*.css`, design tokens in `design-tokens.css`), Roboto + Fira Code via `next/font`,
Material Symbols icon names via an `icon()` helper. 237 Vitest tests, 7 Playwright e2e.

Screens/components (all under `src/features/api-client/components/`):
- TopBar: logo "API Client", WorkspaceChip ("Connect folder"), theme toggle, Import cURL,
  environment select, Environments button.
- Sidebar: History / Collections tabs, Import / Export, search, grouped history, collection tree
  with drag-and-drop (dnd-kit), context menu, move-to.
- RequestTabsBar: tabs with dirty dot, close, new tab.
- UrlBar: protocol select (HTTP / WebSocket / SSE), method select, `{{var}}` input with
  autocomplete + colored tokens, Send / Save / Code.
- RequestPane tabs: Params, Auth (none, Bearer, Basic, API key, OAuth2, JWT), Headers,
  Body (none/raw/JSON/form-data incl. files/urlencoded/GraphQL), Scripts (pre-request), Tests.
- ResponsePane: status, time, size, maximize; Body (Pretty/Raw, filter, download, JSON tree,
  expand/collapse, copy), Headers, Types (TS/Go/Rust/Python/Dart/Kotlin/Swift/Java/C#),
  Diff vs previous run, Cookies, Test results.
- RealtimePane: WebSocket and SSE live message log, send box.
- Modals: Save, Env, Cookies, Curl, Runner (collection runner w/ data file iteration),
  Code (12 languages), MoveTo, Response (fullscreen), CloseTab.
- CommandPalette (Cmd/Ctrl-K), keyboard shortcuts hook.

Pure-logic libs under `lib/` (parseCurl, parseOpenApi, postmanFormat, importExport, codegen,
jsonToTypes, envResolver, collectionTree, collectionRunner, historyGroup, diffLines, parseSse,
syntaxHighlight, format, cookies, tabDirty, pmSandbox...) are framework-free and tested.

Browser-only plumbing that goes away: `app/api/proxy`, `app/api/stream`, `proxyClient.ts`
(fetch-to-proxy), `botWall.ts` + "Retry from browser" UI, localhost-help messages,
`workspaceFs.ts` (File System Access API), `zipWorkspace.ts`, `workspaceFile.ts`, `persist.ts`
(localStorage).

## 6. Decided design

### 6.1 Shell and frontend

- **Tauri 2.12.x** (latest stable; Tauri 3 with optional CEF is alpha, revisit when stable for Linux).
  Rationale (researched 2026-11): the only option that keeps next-postman's React UI byte-identical;
  GPUI/Dioxus-native/egui/iced/Slint all require a UI rewrite and cannot look identical. Hot paths
  (network, storage, search, big bodies) live in Rust regardless.
- **Vite + React 19 + TypeScript + Zustand 5** replaces Next.js. There is no server anymore; Next
  only adds weight. Port `src/features`, `src/components`, CSS files verbatim; `app/page.tsx` +
  `layout.tsx` become `main.tsx` + `index.html`.
- Fonts bundled locally (`@fontsource/roboto`, `@fontsource/fira-code`, Material Symbols font file).
  Zero external requests.
- **UI fidelity rule:** keep markup, class names and CSS unchanged. Only the following visible changes:
  - WorkspaceChip "Connect folder" → **"Settings"** button in the same spot, same chip style
    (opens a Settings modal styled like existing modals; see 6.5).
  - "Retry from browser" / bot-wall UI removed (no longer reachable).
  - Response meta gains a hover popover with timing breakdown (6.3).
  - Everything else pixel-identical. Verify with side-by-side screenshots of the same states
    (next-postman `npm run dev` vs Dakghor) for: empty state, request+JSON response, collections tree,
    env modal, runner modal, realtime pane, dark mode.

### 6.2 Rust core layout

Cargo workspace:
- `crates/dakghor-core` — pure Rust, no Tauri: HTTP engine, WS/SSE, cookie jar, storage, search.
  Fully unit/integration-testable with `cargo test`.
- `src-tauri` — thin Tauri layer: commands, channels, state wiring, window setup.

Runtime: `tokio` (multi-thread). Errors: `thiserror` in core, mapped to a serializable
`{ kind, message }` at the command boundary (kinds mirror next-postman's messages: connection
refused, DNS failed, timeout, reset, TLS, invalid URL...).

### 6.3 HTTP engine

- **`reqwest` 0.13** with `rustls` (+ native roots via `rustls-platform-verifier`), `http2`,
  `gzip`/`brotli`/`deflate`/`zstd` decompression, `stream`. One shared `Client` per settings
  profile (connection pooling = big speed win over next-postman's per-request server fetch).
  A second client is built only when settings change (proxy, TLS verify, redirects).
- Request built entirely in Rust from a serializable `HttpRequestSpec` (method, final URL, headers
  list preserving order and duplicates, body variant, timeout, follow-redirects). Auth/env resolution
  and pre-request scripts stay in TS (they already exist and are tested) and produce the spec.
  Body variants: `none | text(String) | bytes(base64) | form_urlencoded(pairs) | multipart(parts with
  text or file path)`. Files in form-data are sent by **path** (Tauri dialog gives a path), streamed
  from disk by Rust, never loaded into JS.
- Response: status, status text, HTTP version, headers (ordered, duplicates kept), remote addr,
  timing `{ total, ttfb }` measured in Rust (`ttfb` = time to response headers). DNS/connect/TLS
  breakdown is a stretch goal (needs a custom hyper connector); builder may add it if cheap.
- **Large bodies:** the body is stored in a Rust-side `ResponseStore` (LRU by bytes, default 512 MB
  cap, keyed by response id). The command returns metadata + the first **2 MB** inline (as raw bytes
  via `tauri::ipc::Response`, not JSON). The UI requests more/all via `get_response_body(id, range)`
  only when needed (Raw view scroll, Download, full JSON tree). "Download" writes from Rust straight
  to a user-chosen path. Pretty/JSON-tree rendering of >2 MB bodies is offered behind a
  "Load full body" button, and the text views are virtualized (render visible lines only).
- Cancellation: every send has a request id; `cancel_request(id)` aborts the tokio task. Runner
  Cancel uses the same.
- Cookie jar: moved to Rust (`cookie_store` crate), persisted in SQLite. **Behavior upgraded to
  RFC 6265** (Domain/Path matching, Expires/Max-Age, Secure, HttpOnly) — next-postman's exact-host,
  name/value-only jar sends wrong cookies vs. curl/Postman, which this app exists to match. CookiesModal
  keeps its layout (grouped by host, name, value, delete/clear); it additionally shows the path when it
  isn't `/` and an expiry hint. Applied unless the request sets its own `Cookie` header (current
  behavior). *(Builder-check decision.)*
- Settings honored per request: timeout (default 30 s, 0 = none), follow redirects (default on,
  max 10), verify TLS (default on), HTTP proxy URL (none by default; also honor system env proxies
  off by default), default User-Agent `Dakghor/<version>` unless user sets one.

### 6.4 Realtime

- **WebSocket:** `tokio-tungstenite` with rustls. Custom headers + subprotocols allowed. Messages
  stream to UI over a Tauri `Channel` per connection (text, binary as base64 + byte length, open,
  close code/reason, error). Send via command. Connection closes when its tab closes
  (store subscription diffing tab ids — the known `closeTab` last-tab replacement path).
- **SSE:** reqwest streaming + Rust SSE parser (port `parseSse.ts` logic: `event`, `data` multi-line,
  `id`, `retry`, comments). Events delivered over a `Channel`. Reconnect with `Last-Event-ID` as today.
- UI message log keeps the last 5,000 messages / 20 MB per connection in memory (virtualized list),
  never written to the DB per frame.

### 6.5 Storage

- **SQLite via `rusqlite`** (bundled SQLite, features `bundled`, FTS5). Chosen over sqlx (async
  overhead, macros, no benefit for a single local file), redb (key-value, no FTS/queries), and Turso
  (beta). One DB file in the OS app-data dir (`dakghor.db`), WAL mode, `synchronous=NORMAL`,
  dedicated DB thread owning the connection (commands send jobs over a channel), so the UI never
  blocks on I/O.
- Schema (JSON documents + indexed columns; schema version table + forward-only migrations):
  - `collections(id, name, sort, data_json, updated_at)` — whole collection tree as JSON (matches the
    existing `Collection` type; collections are small enough; simplest correct port).
  - `environments(id, name, sort, vars_json, updated_at)`, `globals(vars_json)`,
    `active_env(id)`.
  - `history(id, ts, method, url, status, duration_ms, data_json)` + FTS5 index on `method url`.
    Semantics preserved from next-postman (`historySlice.ts`): one entry per method+URL, a repeat send
    replaces the old entry and moves it to the top. **Cap raised from 50 to 1,000 by default**
    (configurable 50–10,000 in Settings); oldest pruned. Sidebar list is virtualized. *(Builder-check
    decision.)*
  - `tabs(id, sort, data_json)`, `ui_state(key, value_json)` (active tab, theme, pane sizes).
  - `cookies(domain, path, name, data_json)`.
  - `settings(key, value_json)`.
- Frontend persistence: replace `persist.ts` (localStorage) with a `persist` layer that subscribes to
  the store and sends **only the changed entity** (diff by reference, like today), **debounced 300 ms**
  per entity, plus flush on window close. Hydration on start via one `load_workspace` command.
- Secrets: env values stored in the DB as-is (same as next-postman localStorage). OS keychain is a
  later improvement, not v1.
- **Migration from next-postman:** backup import also accepts next-postman's workspace folder / zip
  format — keep `workspaceFile.ts` parsing (import-only) for this. *(Builder-check decision.)*
- Import/export unchanged in format (Postman v2.1, OpenAPI 3.0/3.1 JSON+YAML, cURL); export writes
  files via the Tauri dialog. Additionally: **full backup export/import** (single JSON of everything)
  as the portability escape hatch.

### 6.6 Scripts sandbox

- Pre-request and test scripts move from `new Function` on the main thread to a **dedicated Web
  Worker** running the existing `PmSandbox` logic. Gives: no DOM/store access, UI never freezes,
  hard timeout (default 5 s → `worker.terminate()` + error result). Worker is reused across runs and
  recreated after a timeout.
- Considered `rquickjs` (embedded QuickJS in Rust): rejected for v1 — adds a C build on all three
  platforms and the `pm` API already lives in TS. Revisit if scripts need to run headless (CLI).

### 6.7 Search

- History search via SQLite FTS5 (Rust). Collection search stays in-memory TS (collections are
  in memory anyway).

### 6.8 Settings modal (new, styled like EnvModal)

Timeout, follow redirects, verify TLS, proxy URL, default User-Agent, response store cap,
history limit, theme. Plus "Backup: export all / import all" and "Open data folder".

### 6.9 Build, test, release

- Rust: `cargo test` for core (HTTP engine tested against a local `axum` test server: methods, bodies,
  multipart files, redirects, cookies, gzip/brotli, timeouts, cancel, large body ranges, WS echo, SSE).
  `clippy -D warnings`, `rustfmt`.
- TS: keep and port all 237 Vitest tests that cover surviving code; delete tests of removed plumbing.
- E2E: Playwright against the Vite dev build with a mocked Tauri `invoke` (keeps CI cross-platform
  and fast); plus a manual smoke checklist per release on mac/win/linux.
- CI: GitHub Actions matrix (macos-latest, windows-latest, ubuntu-22.04) building with
  `tauri-action`, producing `.dmg`, `.msi`/`.exe` (NSIS), `.AppImage`/`.deb`. Unsigned in v1.
- Release profile: `lto = "fat"`, `codegen-units = 1`, `opt-level = 3`, `strip = true`,
  `panic = "abort"`.
- License: MIT, keep next-postman's copyright notice alongside ours.

### 6.10 Relationship to next-postman

Dakghor is a **one-time fork**: copy next-postman's frontend at `ae84135`, then refactor freely
(ordered headers, partial response bodies, Rust-backed cookies, etc.). No obligation to stay
mergeable with upstream. Keep `lib/` modules intact where they need no change, simply to reduce work.
*(Builder-check decision.)*

## 7. Left to the builder

- Exact crate minor versions (pin latest stable at implementation time; verify on crates.io).
- Internal module boundaries inside `dakghor-core`, command naming.
- Whether to port `parseSse` to Rust or keep TS parser fed with raw chunks (prefer Rust).
- DNS/connect/TLS timing breakdown (stretch).
- Virtualization library choice for text/log views (or hand-rolled), as long as visuals don't change.
- Order of work, as long as each step leaves a runnable app.

## 8. Risks

- **Linux WebKitGTK** rendering is slower and buggy on some NVIDIA setups. Mitigation: virtualized
  views, no heavy CSS effects added, document Tauri's `WEBKIT_DISABLE_DMABUF_RENDERER` workaround.
  Move to Tauri 3 CEF backend when stable.
- WebKit (macOS/Linux) vs Chromium (next-postman's usual browser) CSS differences may cause small
  visual drift — covered by the screenshot comparison.
- reqwest normalizes some headers (e.g. header name case on HTTP/1). Acceptable; documented.
