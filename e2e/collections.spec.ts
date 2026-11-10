import { test, expect } from '@playwright/test';

test('creates a collection', async ({ page }) => {
  await page.goto('/');

  // Switch to Collections sidebar
  await page.locator('.sidebar-tab', { hasText: 'Collections' }).click();

  // Click "New Collection" button (inside .sidebar-search)
  await page.locator('.sidebar-search .md-text-btn').click();

  // Wait for inline rename input
  const renameInput = page.locator('.tree-rename-input');
  await expect(renameInput).toBeVisible({ timeout: 5000 });

  await renameInput.fill('E2E Test Collection');
  await renameInput.press('Enter');

  await expect(page.locator('.collection-root')).toContainText('E2E Test Collection');
});
