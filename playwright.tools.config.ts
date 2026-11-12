import { defineConfig, devices } from '@playwright/test';

/**
 * Measurement/documentation runs, not part of `npm run test:e2e`:
 * - e2e/tools/fidelity.spec.ts — screenshot pairs reference app vs VectisAPI → docs/fidelity/
 * - e2e/tools/large-body.spec.ts — 50 MB body first-paint timing → docs/perf.md
 *
 * Run: `npx playwright test -c playwright.tools.config.ts [file]`. The fidelity run needs
 * the reference app's dependencies installed at $REF_DIR (default ../reference-app).
 */
const REF_DIR = process.env.REF_DIR ?? '../reference-app';
const withRef = process.env.FIDELITY_REF !== '0';

export default defineConfig({
  testDir: './e2e/tools',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
  webServer: [
    {
      command: 'npx vite build --mode e2e --outDir dist-e2e --emptyOutDir && node e2e/csp-server.mjs dist-e2e 1431',
      url: 'http://localhost:1431',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    ...(withRef
      ? [
          {
            command: 'npm run dev -- --port 3000',
            cwd: REF_DIR,
            url: 'http://localhost:3000',
            reuseExistingServer: true,
            timeout: 180_000,
          },
        ]
      : []),
  ],
});
