import { test, expect } from '@playwright/test';

test('app loads and shows the logo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.logo')).toContainText('API Client');
});

test('can switch to collections sidebar', async ({ page }) => {
  await page.goto('/');
  const collectionsTab = page.locator('.sidebar-tab', { hasText: 'Collections' });
  await collectionsTab.click();
  await expect(collectionsTab).toHaveClass(/active/);
  await expect(page.locator('.sidebar-actions')).toContainText('Import');
});

test('can create a new tab', async ({ page }) => {
  await page.goto('/');
  const count = await page.locator('.req-tab').count();
  await page.locator('[title*="New Tab"]').click();
  await expect(page.locator('.req-tab')).toHaveCount(count + 1);
});

test('theme toggle switches mode', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const initial = await html.getAttribute('data-theme');
  await page.locator('[title="Toggle theme"]').click();
  const next = await html.getAttribute('data-theme');
  expect(next).not.toBe(initial);
});
