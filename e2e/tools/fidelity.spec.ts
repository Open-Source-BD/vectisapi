import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Side-by-side screenshots of next-postman (NP, `npm run dev`) and VectisAPI (VA, the e2e build
 * with mockTauri) in identical states, light + dark, at 1280×800. Both apps get the same seeded
 * workspace and are driven through the same clicks; network is mocked on both sides (NP's
 * /api/proxy and WebSocket via page.route / routeWebSocket, VA via mockIPC).
 *
 * Output: docs/fidelity/<state>-<theme>-<np|va|va-webkit>.png (committed copies are palette-quantized, see README).
 */
const OUT = process.env.FIDELITY_OUT ?? 'docs/fidelity';
const NP_URL = 'http://localhost:3000/';
const VA_URL = 'http://localhost:1431/';

const RESPONSE_BODY = JSON.stringify(
  {
    args: {},
    headers: { Accept: '*/*', Host: 'httpbin.org' },
    origin: '203.0.113.7',
    url: 'https://httpbin.org/get',
    slideshow: { author: 'Yours Truly', date: 'date of publication', slides: [{ title: 'Wake up', type: 'all' }] },
  },
  null,
  2,
);

function tab(id: string, url: string, method = 'GET') {
  return {
    id,
    protocol: 'http',
    method,
    url,
    params: [],
    headers: [],
    auth: {
      type: 'none',
      bearer: '',
      basicUser: '',
      basicPass: '',
      apiKeyName: '',
      apiKeyValue: '',
      apiKeyIn: 'header',
      oauthToken: '',
      jwtToken: '',
      jwtPrefix: 'Bearer',
    },
    body: { type: 'none', formdata: [], urlencoded: [], rawContent: '', rawType: 'application/json' },
    scripts: '',
    tests: '',
    response: null,
    activeSubTab: 'params',
    activeResTab: 'body',
  };
}

const collections = [
  {
    id: 'col-1',
    name: 'Pet Store',
    date: '2026-11-01T10:00:00.000Z',
    children: [
      {
        id: 'fold-1',
        type: 'folder',
        name: 'Pets',
        children: [
          { id: 'req-1', type: 'request', name: 'List pets', request: tab('t-req-1', '{{baseUrl}}/pets') },
          { id: 'req-2', type: 'request', name: 'Create pet', request: tab('t-req-2', '{{baseUrl}}/pets', 'POST') },
        ],
      },
      { id: 'req-3', type: 'request', name: 'Health', request: tab('t-req-3', '{{baseUrl}}/health') },
    ],
  },
  { id: 'col-2', name: 'Auth API', date: '2026-11-02T10:00:00.000Z', children: [] },
];

const environments = [
  {
    id: 'env-1',
    name: 'Local',
    vars: [
      { id: 'v1', key: 'baseUrl', value: 'http://localhost:8080' },
      { id: 'v2', key: 'token', value: 'dev-token-123' },
    ],
  },
  { id: 'env-2', name: 'Staging', vars: [{ id: 'v3', key: 'baseUrl', value: 'https://staging.example.com' }] },
];

type Theme = 'light' | 'dark';
type Target = 'np' | 'va';

/** Seeds the same workspace into either app before it boots. */
async function boot(page: Page, target: Target, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme });
  const seed = {
    collections,
    environments,
    theme,
    body: RESPONSE_BODY,
    longValue: 'eyJsYW5nIjoiZW4iLCJ0aGVtZSI6ImRhcmsiLCJsYXlvdXQiOiJjb21wYWN0In0.' + 'a1b2c3d4'.repeat(12),
  };
  if (target === 'np') {
    await page.addInitScript((s) => {
      localStorage.setItem('next-postman-collections', JSON.stringify(s.collections));
      localStorage.setItem('next-postman-environments', JSON.stringify(s.environments));
      localStorage.setItem('next-postman-active-env', JSON.stringify('env-1'));
      localStorage.setItem('next-postman-theme', JSON.stringify(s.theme));
      localStorage.setItem(
        'next-postman-cookies',
        JSON.stringify({
          'httpbin.org': [
            { name: 'session', value: 'abc123' },
            { name: 'prefs', value: s.longValue },
          ],
        }),
      );
    }, seed);
    await page.route('**/api/proxy', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'x-proxy-time': '42' },
        body: seed.body,
      }),
    );
    await page.routeWebSocket(/echo\.test/, (ws) => ws.onMessage((m) => ws.send(m)));
    await page.goto(NP_URL);
  } else {
    await page.addInitScript((s) => {
      window.__VECTIS_MOCK__ = {
        body: s.body,
        snapshot: {
          collections: s.collections,
          environments: s.environments,
          activeEnvId: 'env-1',
          uiState: { theme: s.theme },
        },
        cookies: [
          {
            domain: 'httpbin.org',
            path: '/',
            name: 'session',
            value: 'abc123',
            expires: 1893456000,
            secure: true,
            httpOnly: true,
          },
          {
            domain: 'httpbin.org',
            path: '/api/v2/preferences',
            name: 'prefs',
            value: s.longValue,
            expires: null,
            secure: false,
            httpOnly: false,
          },
        ],
      };
    }, seed);
    await page.goto(VA_URL);
  }
  await expect(page.locator('.logo')).toContainText('API Client');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page: Page, name: string) {
  // Let transitions/caret settle; hide the blinking caret (and Next's dev-only indicator on NP).
  await page.addStyleTag({
    content: '*{caret-color:transparent !important;transition:none !important} nextjs-portal{display:none !important}',
  });
  await page.mouse.move(0, 799);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

const states: Record<string, (page: Page) => Promise<void>> = {
  '1-empty': async () => {},
  '2-response': async (page) => {
    await page.getByRole('textbox', { name: 'Request URL' }).fill('https://httpbin.org/get');
    await page.locator('.send-btn', { hasText: 'Send' }).click();
    await expect(page.locator('.status-badge')).toContainText('200');
  },
  '3-collections': async (page) => {
    await page.locator('.sidebar-tab', { hasText: 'Collections' }).click();
    await expect(page.locator('.collection-root').first()).toBeVisible();
  },
  '4-env-modal': async (page) => {
    await page.getByRole('button', { name: 'Environments' }).click();
    await expect(page.locator('.md-modal').first()).toBeVisible();
  },
  '5-runner-modal': async (page) => {
    await page.locator('.sidebar-tab', { hasText: 'Collections' }).click();
    await page.locator('.collection-row').first().click({ button: 'right' });
    await page.getByRole('button', { name: /Run$/ }).click();
    await expect(page.locator('.md-modal').first()).toBeVisible();
  },
  '6-realtime': async (page) => {
    await page.locator('.method-select').first().selectOption('ws');
    await page.getByRole('textbox', { name: 'WS URL' }).fill('wss://echo.test/socket');
    await page.locator('.send-btn', { hasText: 'Connect' }).click();
    await expect(page.locator('.send-btn', { hasText: 'Disconnect' })).toBeVisible();
    for (const msg of ['hello', '{"type":"ping","id":1}']) {
      await page.locator('.rt-input').fill(msg);
      await page.locator('.rt-send').click();
    }
    await expect(page.locator('.rt-row')).toHaveCount(4);
  },
  '7-form-data': async (page) => {
    await page.getByRole('button', { name: 'Body' }).first().click();
    await page.locator('.md-radio', { hasText: 'formdata' }).click();
    const panel = page.locator('.md-tab-content.active');
    if ((await panel.locator('.kv-row').count()) === 0) await panel.locator('.add-row-btn').click();
    await panel.locator('.kv-row').first().locator('.kv-input').first().fill('avatar');
    await panel.locator('.kv-type-select').first().selectOption('file');
    await panel.locator('.add-row-btn').click();
    await panel.locator('.kv-row').nth(1).locator('.kv-input').first().fill('name');
  },
  '8-cookies': async (page) => {
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByText('Manage cookies').click();
    await expect(page.getByText('session').first()).toBeVisible();
  },
};

mkdirSync(OUT, { recursive: true });

for (const theme of ['light', 'dark'] as const) {
  for (const [state, run] of Object.entries(states)) {
    for (const target of ['np', 'va'] as const) {
      test(`${state} ${theme} ${target}`, async ({ page, browserName }) => {
        test.skip(
          target === 'np' && (browserName !== 'chromium' || process.env.FIDELITY_NP === '0'),
          'NP shots: Chromium only',
        );
        await boot(page, target, theme);
        await run(page);
        const suffix = target === 'va' && browserName === 'webkit' ? 'va-webkit' : target;
        await shot(page, `${state}-${theme}-${suffix}`);
      });
    }
  }
}

test('settings modal (VA only)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium');
  for (const theme of ['light', 'dark'] as const) {
    await boot(page, 'va', theme);
    await page.locator('.ws-chip').click();
    await page.waitForTimeout(200);
    await shot(page, `9-settings-${theme}-va`);
  }
});
