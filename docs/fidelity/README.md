# UI fidelity: next-postman vs VectisAPI

Side-by-side screenshots of next-postman (**NP**, `npm run dev`, commit `ae84135`) and VectisAPI
(**VA**, the React UI built with `vite build --mode e2e` and served with the production CSP; the Rust
layer replaced by `src/test/mockTauri.ts`). Both apps get the same seeded workspace (2 collections,
2 environments, 1 cookie domain) and the same clicks; network is mocked on both sides.

- Viewport 1280×800, device scale 1, Chromium (Playwright 1.64, Chrome 156) for NP and VA.
- VA again in Playwright **WebKit** (closest engine to WKWebView / WebKitGTK): `*-va-webkit.png`.
- Light and dark theme for every state.
- PNGs are palette-quantized (256 colours) to keep this folder small; diffs below were measured on
  the raw captures.

Regenerate (needs next-postman's deps installed at `../next-postman`, or `NP_DIR`):

```sh
npx playwright test -c playwright.tools.config.ts fidelity
```

## States

| # | State | Files |
|---|-------|-------|
| 1 | Empty state | `1-empty-{light,dark}-{np,va,va-webkit}.png` |
| 2 | Request + JSON response | `2-response-…` |
| 3 | Collections tree | `3-collections-…` |
| 4 | Environments modal | `4-env-modal-…` |
| 5 | Collection runner modal | `5-runner-modal-…` |
| 6 | Realtime (WebSocket) pane, 2 sent + 2 echoed | `6-realtime-…` |
| 7 | Body → form-data with a File row (Task 9 file cell) | `7-form-data-…` |
| 8 | Cookies modal (Task 8 path/expiry hint, long value) | `8-cookies-…` |
| 9 | Settings modal (VA only, new) | `9-settings-{light,dark}-va.png` |

Dark mode is covered by the `-dark` variant of every state.

## Every visible difference

Pixel diff NP vs VA (Chromium; per-pixel difference converted to luminance, threshold 24/255) is 0.05–0.7 % of the frame per state after the
fixes below. These percentages were measured on the raw (unquantized) captures, which are not
committed; `scripts/fidelity-diff.py` reproduces them from a fresh capture
(`FIDELITY_OUT=<dir> npx playwright test -c playwright.tools.config.ts fidelity`, then
`python3 scripts/fidelity-diff.py <dir>`). Run on the committed quantized PNGs it reports similar
bands with a little extra quantization noise. Each remaining region:

| Where | Difference | Verdict |
|-------|------------|---------|
| Top bar chip (all states) | NP "Connect folder" chip → VA "Settings" chip, same spot and chip style; the chip is narrower so it starts ~45 px further right | **Allowed** (WorkspaceChip → Settings) |
| Settings modal (state 9) | New modal, styled like the existing modals | **Allowed** |
| Form-data File cell (state 7) | NP: native `<input type=file>` ("Choose File" button + "No file chosen"). VA: a button styled as the cell's `md-input`, reading "Choose file" (file name once picked) and opening the native dialog | **Ruled deviation** (Task 9: a web file input cannot yield a path for the Rust multipart body). Same box, size and position; only the content differs. Not in the global allowed list — flagged for the controller |
| Cookies modal (state 8) | VA adds the cookie path (when not `/`) and `expires …` / `session` after the value | **Allowed** (cookie path/expiry hint) |
| Realtime log (state 6) | Timestamps differ (capture time) | Data only. Row layout, icons, sizes, composer and status bar identical (Task 12 check) |
| Tab label, response meta line, JSON toolbar, runner "Data file" button | Sub-pixel anti-aliasing on a few glyphs, no geometry change | Not visible. Same Roboto/Fira Code families, but VA bundles `@fontsource` builds while NP's `next/font` serves Google's build |
| NP bottom-left | Next.js dev-mode indicator | NP dev-server only; hidden in the captures |

Not captured, because they only appear on hover or with a truncated body: the timing popover on
the response meta and the "Load full body" control. Both are **allowed** additions; they are covered
by unit tests and `e2e/tools/large-body.spec.ts`.

### Bugs found and fixed in this task

| Bug | Fix |
|-----|-----|
| Every Material Symbol rendered at 20 px instead of NP's 24 px (and JSON tree rows 2 px shorter): NP's Google Fonts stylesheet loads *after* the app CSS, so its `font-size: 24px` wins over `base.css`; VA imported the icon CSS first | Import the icon CSS after `globals.css` (`src/main.tsx`) |
| Cookies modal: with a long value the path and expiry hint were ellipsized to `/api…` and `s…` | `.cookies-path` / `.cookies-hint` don't shrink (`src/app/overlays.css`) |

## WebKit vs Chromium (VA)

The WebKit set shows the same layout in every state, light and dark. Differences are engine
rendering only: native `<select>` controls draw macOS-style up/down chevrons, text is rasterized
slightly differently, and the locale date in the cookie hint reads `Jan 1, 2030 at 6:00 AM`
(WebKit's `Intl`) instead of `Jan 1, 2030, 6:00 AM`. No clipping, overflow or missing icons.

Modal scrim: in Chromium (NP and VA) the page behind an open modal is blurred
(`.md-modal-overlay { backdrop-filter: blur(2px) }`, unchanged from NP); in the Playwright WebKit
captures it is a flat grey scrim with no blur. This is treated as an engine artifact of headless
Playwright WebKit, not a VA bug (the CSS is NP's, byte for byte). Whether the real WKWebView /
WebKitGTK blurs is a manual check: `docs/manual-smoke.md` §9.

The CSP check (`e2e/csp.spec.ts`) passes in both engines: with the production CSP on the HTML
(`script-src 'self'`, no `'unsafe-eval'`), a pre-request script still runs in the worker.
