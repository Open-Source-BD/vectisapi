# Performance

Measured 2026-11-11 on the release build (`lto = "fat"`, `codegen-units = 1`, `opt-level = 3`,
`strip`, `panic = "abort"`), commit after Task 16.

Machine: MacBook Air M2 (Mac14,2), 8 GB RAM, macOS 26.6.2. The machine was shared and busy
(load average 4–9, disk 95 % full), so startup and memory numbers vary run to run.

## Summary

| Metric | Target | Result | Status |
|--------|--------|--------|--------|
| Per-request engine overhead (local server, median of 100) | < 5 ms | **4–8 µs** over raw reqwest (engine median 41–79 µs) | Met |
| 50 MB body → first paint of the body view | < 300 ms | **23–32 ms** Chromium, **13–18 ms** WebKit (UI side, see method) | Met (UI side) |
| "Load full body" on a 50 MB body | (no target; ruling: accept ≤ 0.5 s hitch) | **48–88 ms**, longest main-thread task **≤ 58 ms** | OK |
| Send after a 50 MB body was fully loaded | < 300 ms, UI never blocks | **14–31 ms** (was 315–814 ms before this task's fix) | Met (fixed) |
| History search over 10k entries | < 50 ms | **0.70–0.89 ms** | Met |
| Installer size (macOS) | < 15 MB | **6.3 MB** `.dmg` (`.app` 12.0 MB unpacked) | Met |
| Cold start: process launch → main window on screen | < 1 s | **284–1934 ms**, median ≈ 800 ms over 10 runs; 2 of 10 over 1 s | Mostly met (see notes) |
| Idle RAM after 10 s | < 150 MB | main process RSS 24–111 MB; whole app (main + WebKit helpers) **phys footprint 80–207 MB, median 93 MB** | Met at median, **missed in 2 of 6 runs** |

## Methods and raw numbers

### Per-request overhead

`crates/vectis-core/tests/overhead.rs` (release only):

```sh
cargo test --release -p vectis-core --test overhead -- --nocapture
```

A local axum server (`tests/support/server.rs`, `GET /json`); 20 warm-up requests, then 100
interleaved pairs: `HttpEngine::send` (spec → reqwest → cookie jar → ResponseStore → meta) vs a bare
`reqwest::Client` doing `get().send().bytes()`. Overhead = difference of medians; the test asserts
< 5 ms.

| Run | Engine median | Raw reqwest median | Overhead |
|-----|---------------|--------------------|----------|
| 1 | 41.1 µs | 37.6 µs | 3.5 µs |
| 2 | 58.3 µs | 51.5 µs | 6.8 µs |
| 3 | 79.4 µs | 72.0 µs | 7.5 µs |

Not included: the Tauri IPC hop (JS `invoke` → Rust command → binary response). It isn't
measurable headlessly; it is one raw-bytes IPC call per send (no JSON encoding of the body).

### 50 MB body

`e2e/tools/large-body.spec.ts`:

```sh
FIDELITY_NP=0 npx playwright test -c playwright.tools.config.ts large-body
```

The built UI (`vite build --mode e2e`) with `mockTauri` answering `send_request` exactly as Rust
does for a 50 MB body: a frame with `size` = 52,428,800, `truncated: true` and the 2 MB prefix;
`get_response_body` returns all 50 MB. The mocked body is generated before the first click, so the
numbers are UI cost only. Timing is taken in the page: a capturing click listener stamps `t0`, then
the next animation frame after the DOM shows the body (first rows of the preview, or the preview
notice gone for "Load full body") stamps `t1`. Chromium 156 and WebKit 27.2 (Playwright), 1280×800.

| | Chromium (ms) | WebKit (ms) |
|-|---------------|-------------|
| First paint, 5 sends | 23, 31, 32, 32, 32 | 18, 13, 13, 13, 14 |
| Load full body, 3× | 48, 65, 64 | 76, 72, 56 |
| Longest task within 1.5 s after Load full body | 0, 56, 58 | (no Long Tasks API) |
| Send replacing a fully loaded 50 MB view, 3× | 30, 30, 29 | 14, 14, 15 |

Not included: Rust receiving 50 MB and the IPC transfer of the 2 MB prefix (end-to-end needs the
real app; see `docs/manual-smoke.md` §5).

**Bug found and fixed:** each successful send deep-cloned the whole tab, including `prevResponse`,
for the history snapshot (`JSON.parse(JSON.stringify(tab))`), and stored it in history. After
"Load full body" that was 100+ MB of JSON per send: 315–814 ms of blocked UI, and the body written
into SQLite. The snapshot now drops both responses before cloning (`src/features/api-client/lib/sendActive.ts`,
covered by `sendActive.test.ts`).

### History search, 10k entries

```sh
cargo test --release -p vectis-core --test db -- --nocapture history_search_fts_10k
```

10,000 history rows in SQLite (FTS5), query `users` matching 1,000 of them, limit 1,000:
712.9 µs, 889.0 µs, 699.5 µs (3 runs). The test asserts < 50 ms.

### Installer size

`npm run tauri build` on macOS (aarch64):

| Artifact | Size |
|----------|------|
| `VectisAPI_0.1.0_aarch64.dmg` | 6,621,340 B (6.3 MiB) |
| `VectisAPI.app` | 11.99 MiB (binary 12,463,968 B with the frontend embedded) |
| Frontend `dist/` | 1.6 MB |

The Material Symbols font is subset to the 89 icons the UI uses: 65 KB instead of 3.8 MB
(`scripts/subset-icons.py`, offline with fontTools; guarded by `src/test/iconSubset.test.ts`).
Windows (msi/nsis) and Linux (AppImage/deb) sizes come from the release workflow and aren't
measured here; the binary is the same Rust + embedded frontend, so they should be comparable
(AppImage bundles WebKitGTK-adjacent libraries and is larger by design).

### Cold start and idle RAM

The release binary `target/release/bundle/macos/VectisAPI.app/Contents/MacOS/vectisapi` launched in
the background; a small Swift helper polls `CGWindowListCopyWindowInfo` every 2 ms and reports
when the process owns an on-screen layer-0 window. After 10 s: `ps -o rss=` for the main process
and for the WebKit helper processes (WebContent, GPU, Networking) that appeared after launch, plus
`footprint` (physical footprint, which doesn't double count shared pages); then the app is killed.
Existing small workspace database.

| Run | Window on screen | Main RSS | Helpers RSS | RSS sum | Phys footprint (all) |
|-----|------------------|----------|-------------|---------|----------------------|
| 1 | 787 ms | 32.0 MB | 15.0 MB | 47 MB | — |
| 2 | 1934 ms | 23.4 MB | 14.9 MB | 38 MB | — |
| 3 | 1587 ms | 26.7 MB | 15.3 MB | 41 MB | — |
| 4 | 976 ms | 45.8 MB | 28.9 MB | 74 MB | — |
| 5 | 902 ms | 58.3 MB | 60.4 MB | 118 MB | 80 MB |
| 6 | 685 ms | 39.5 MB | 35.8 MB | 75 MB | 87 MB |
| 7 | 806 ms | 108.8 MB | 146.7 MB | 255 MB | 180 MB |
| 8 | 302 ms | 96.9 MB | 85.4 MB | 182 MB | 100 MB |
| 9 | 284 ms | 91.0 MB | 79.3 MB | 170 MB | 85 MB |
| 10 | 309 ms | 108.5 MB | 123.2 MB | 231 MB | 207 MB |

Notes:

- "Window on screen" is when macOS shows the window, not when the UI is interactive (the webview
  may still be loading); "interactive" is not measurable headlessly. Runs 1–4 were launched while
  the machine's load average was ~9; runs 8–10 at ~4.
- Low RSS in runs 1–4 is the OS compressing a background app's memory (the app was never
  frontmost); `footprint` is the better number. Footprint met < 150 MB in 4 of 6 runs; runs 7 and 10
  (180 / 207 MB) missed it, driven by the WebContent process (72–94 MB RSS).
- Main-process RSS alone (the brief's `ps -o rss=`) is 24–111 MB: always < 150 MB.
- Cold start and RAM should be re-checked on an idle machine and on Windows (WebView2) per
  `docs/manual-smoke.md` §8.
