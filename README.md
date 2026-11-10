# VectisAPI

A free, offline, cross-platform desktop API client (macOS, Windows, Linux) — a Postman
alternative. It is a port of [next-postman](https://github.com/Open-Source-BD/next-postman) to
**Tauri 2**: the same React UI, with every request sent by a native **Rust** engine instead of a
web server or the browser. No CORS, no proxy, no account, no network calls of its own.

## Features

- **HTTP**: any method, params, headers (including `Cookie`, `Host`, `User-Agent`, `Origin`),
  auth (Bearer, Basic, API key, OAuth token, JWT), bodies (raw, JSON, form-data with real files,
  urlencoded, GraphQL). Reaches `localhost`, LAN hosts and self-signed HTTPS (opt-in).
- **Responses**: pretty JSON tree, raw, headers, generated TypeScript types, diff with the previous
  run, timing breakdown, exact-bytes download. Bodies of any size: the first 2 MB render
  immediately, the rest loads on demand ("Load full body").
- **Realtime**: WebSocket (with custom headers and subprotocols) and Server-Sent Events.
- **Scripts**: Postman-style pre-request and test scripts (`pm.*`), run in a sandboxed worker.
- **Collections** with folders, drag and drop, a collection runner with data files, Postman v2.1
  import/export, OpenAPI import, cURL import, code generation.
- **Environments** and globals with `{{var}}` autocomplete; a cookie jar (RFC 6265).
- **History** with full-text search; light and dark themes; keyboard shortcuts and command palette.
- **Offline storage** in a local SQLite database, saved as you type; full backup export/import.

## Install

Download the installer for your OS from the
[Releases](../../releases) page:

| OS | File |
|----|------|
| macOS (Apple silicon + Intel) | `VectisAPI_<version>_universal.dmg` |
| Windows | `VectisAPI_<version>_x64-setup.exe` (NSIS) or `.msi` |
| Linux | `VectisAPI_<version>_amd64.AppImage` or `.deb` |

The builds are **not code-signed**:

- **macOS**: the first time, right-click the app → **Open** → **Open** (or run
  `xattr -dr com.apple.quarantine /Applications/VectisAPI.app`).
- **Windows**: SmartScreen may warn; choose **More info → Run anyway**.

### Linux note

On some GPU/driver combinations (notably NVIDIA, and some Wayland sessions) WebKitGTK shows a blank
or flickering window. Start the app with the DMA-BUF renderer disabled:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 vectisapi
```

(For the AppImage: `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./VectisAPI_*.AppImage`.)

## Where your data lives

Everything (collections, environments, globals, tabs, history, cookies, settings) is in one SQLite
file, `vectisapi.db`, in the OS app-data folder:

| OS | Folder |
|----|--------|
| macOS | `~/Library/Application Support/dev.vectisapi.app/` |
| Windows | `%APPDATA%\dev.vectisapi.app\` |
| Linux | `~/.local/share/dev.vectisapi.app/` (or `$XDG_DATA_HOME/dev.vectisapi.app/`) |

**Settings → Open data folder** opens it. **Settings → Export all / Import all** writes and restores
a full backup file. Response bodies are kept in memory only (up to the store cap set in Settings).

## Migrating from next-postman

1. In next-postman, use its workspace folder (the one connected with "Connect folder"), or zip it.
2. In VectisAPI, open **Settings** (top bar) → **Import next-postman workspace (zip)** or
   **(folder)** and pick it.

Collections, environments and globals are merged in by id. Postman v2.1 collection files exported
from next-postman can also be imported from the sidebar (**Collections → Import**).

## Scripts and the Content Security Policy

The app window runs under a strict CSP (`script-src 'self'`, no `'unsafe-eval'`, no network
`connect-src`). Pre-request and test scripts are compiled inside a dedicated Web Worker, whose
script is served without the page CSP, so scripts work while the UI itself cannot evaluate code.
If a webview ever applied the page CSP to the worker, scripts would fail with "Scripts are blocked
by the content security policy" rather than silently weakening the policy. This is covered by an
end-to-end test in Chromium and WebKit (`e2e/csp.spec.ts`).

## Build from source

Requirements: Node 20.19+ (see `.nvmrc`), stable Rust, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On Debian/Ubuntu:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
npm ci
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # release build + installers in target/release/bundle/
```

### Checks

```sh
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck && npm run lint && npm run format:check
npm test               # unit tests (Vitest)
npm run test:e2e       # Playwright, Chromium + WebKit, Rust layer mocked
```

Measurement runs (not part of CI): `npx playwright test -c playwright.tools.config.ts`
(fidelity screenshots → `docs/fidelity/`, 50 MB body timing → `docs/perf.md`).

The icon font is a subset of Material Symbols; after using a new icon run
`python3 scripts/subset-icons.py` (needs `pip install fonttools brotli`). A unit test fails if an
icon is missing from the subset.

## Project layout

- `crates/vectis-core` — Rust core: HTTP engine, WebSocket/SSE, cookie jar, SQLite storage, search.
- `src-tauri` — the Tauri app: IPC commands, window, state.
- `src` — the React UI (ported from next-postman).
- `docs/` — design spec, fidelity screenshots, performance numbers, manual smoke checklist.

## License

MIT — see [LICENSE](LICENSE). VectisAPI is derived from next-postman (MIT).
