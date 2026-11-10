import { test, expect } from '@playwright/test';

/**
 * 50 MB response: time from the Send click to the body's first rows painted, and from the
 * "Load full body" click to the full body painted. mockTauri returns what Rust returns: a frame
 * with `size` = 50 MB, `truncated: true` and the 2 MB prefix; `get_response_body` serves 50 MB.
 * Timestamps are taken in the page (click listener → next animation frame after the DOM shows
 * the body), so Playwright round-trips aren't counted. Numbers → docs/perf.md.
 */
const SIZE = 50 * 1024 * 1024;
const RUNS = 5;

declare global {
  interface Window {
    __mark?: (sel: () => boolean) => Promise<number>;
    __longTasks?: number[];
  }
}

test('50 MB body: first paint and full load', async ({ page, browserName }) => {
  await page.addInitScript((size) => {
    window.__VECTIS_MOCK__ = { bodySize: size };
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks!.push(e.duration);
      }).observe({ type: 'longtask' });
    } catch {
      // WebKit: no Long Tasks API
    }
    // Resolves with ms from the next click until `done()` holds, measured at the following frame.
    window.__mark = (done) =>
      new Promise((resolve) => {
        let t0 = 0;
        document.addEventListener('click', () => (t0 = performance.now()), { capture: true, once: true });
        const check = () => {
          if (t0 && done()) requestAnimationFrame(() => resolve(performance.now() - t0));
          else setTimeout(check, 0);
        };
        check();
      });
  }, SIZE);
  await page.goto('http://localhost:1431/');
  await page.getByRole('textbox', { name: 'Request URL' }).fill('https://big.test/50mb');

  const firstPaint: number[] = [];
  const fullLoad: number[] = [];
  const afterFull: number[] = [];
  /** Chromium: longest main-thread task within 1.5 s of clicking "Load full body". */
  const longest: number[] = [];
  const sendAndPaint = async () => {
    const paint = page.evaluate(() =>
      window.__mark!(() => {
        const notice = document.querySelector('.body-notice');
        return !!notice && /"id":\s*0000000/.test(document.querySelector('.response-pane')?.textContent ?? '');
      }),
    );
    await page.locator('.send-btn', { hasText: 'Send' }).click();
    const ms = await paint;
    await expect(page.locator('.status-badge')).toContainText('200');
    return ms;
  };
  // A: repeated sends of the 50 MB response (each replaces a truncated preview).
  for (let i = 0; i < RUNS; i++) firstPaint.push(await sendAndPaint());
  // B: "Load full body", then a send that replaces the fully loaded 50 MB view.
  for (let i = 0; i < 3; i++) {
    const full = page.evaluate(() => window.__mark!(() => !document.querySelector('.body-notice')));
    if (browserName === 'chromium') await page.evaluate(() => window.__longTasks!.splice(0));
    await page.getByRole('button', { name: /Load full body/ }).click();
    fullLoad.push(await full);
    if (browserName === 'chromium') {
      await page.waitForTimeout(1500);
      longest.push(await page.evaluate(() => Math.max(0, ...window.__longTasks!)));
    }
    afterFull.push(await sendAndPaint());
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const fmt = (v: number[]) => v.map((x) => x.toFixed(0)).join(', ');
  console.log(`[${browserName}] first paint ms: ${fmt(firstPaint)} → median ${median(firstPaint).toFixed(0)}`);
  console.log(`[${browserName}] load full body ms: ${fmt(fullLoad)} → median ${median(fullLoad).toFixed(0)}`);
  if (longest.length) console.log(`[${browserName}] longest task after load full ms: ${fmt(longest)}`);
  console.log(`[${browserName}] send after full body ms: ${fmt(afterFull)} → median ${median(afterFull).toFixed(0)}`);
});
