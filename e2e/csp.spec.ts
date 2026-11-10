import { test, expect } from '@playwright/test';

// The built app served with the exact production CSP (header on the HTML only, as Tauri does).
// `script-src 'self'` has no 'unsafe-eval'; pre-request scripts run in a Web Worker whose own
// policy comes from its (CSP-less) script response, so `new Function` must still work there.
const CSP_URL = 'http://localhost:1431/';

test('pre-request script runs under the production CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/content security policy/i.test(msg.text())) violations.push(msg.text());
  });
  const response = await page.goto(CSP_URL);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");

  await page.getByRole('textbox', { name: 'Request URL' }).fill('https://api.example.test/{{seg}}');
  await page.getByRole('button', { name: 'Scripts' }).first().click();
  await page.locator('.md-tab-content.active textarea').fill('pm.environment.set("seg", "from-script");');
  await page.locator('.send-btn', { hasText: 'Send' }).click();

  await expect(page.locator('.status-badge')).toContainText('200', { timeout: 20000 });
  // The mock echoes the URL it was asked to send: the script's variable was interpolated.
  await expect(page.locator('.response-pane')).toContainText('https://api.example.test/from-script');
  await expect(page.locator('body')).not.toContainText('Scripts are blocked by the content security policy');
  expect(violations).toEqual([]);
});
