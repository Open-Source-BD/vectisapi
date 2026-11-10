import { test, expect } from '@playwright/test';

test('sends a GET request and shows response', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'Request URL' }).fill('https://httpbin.org/get');
  await page.locator('.send-btn', { hasText: 'Send' }).click();

  await expect(page.locator('.response-pane')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.status-badge')).toContainText('200', { timeout: 20000 });
});

test('sends a POST request with raw JSON body', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'Request URL' }).fill('https://httpbin.org/post');

  // Switch to POST method (second .method-select is the HTTP method)
  const methodSelects = page.locator('.method-select');
  await methodSelects.nth(1).selectOption('POST');

  // Open Body tab
  await page.getByRole('button', { name: 'Body' }).first().click();

  // Select raw radio
  await page.locator('.md-radio', { hasText: 'raw' }).click();

  // Type body
  await page.getByPlaceholder('Enter request body here...').fill(JSON.stringify({ hello: 'world' }));

  // Send
  await page.locator('.send-btn', { hasText: 'Send' }).click();

  await expect(page.locator('.status-badge')).toContainText('200', { timeout: 20000 });
});
