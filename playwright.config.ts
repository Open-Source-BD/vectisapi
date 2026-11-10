import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite: the React UI in a plain browser with the Rust command layer replaced by
 * `src/test/mockTauri.ts` (`vite --mode e2e`). `csp.spec.ts` runs against the built app served
 * with the production CSP (see e2e/csp-server.mjs), as Tauri serves it.
 */
const DEV_PORT = 1430;
const CSP_PORT = 1431;

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['tools/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${DEV_PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: `npx vite --mode e2e --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npx vite build --mode e2e --outDir dist-e2e --emptyOutDir && node e2e/csp-server.mjs dist-e2e ${CSP_PORT}`,
      url: `http://localhost:${CSP_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
