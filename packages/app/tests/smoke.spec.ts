import { test, expect } from '@playwright/test';

test.describe('phase-1 / M0 smoke', () => {
  test('app loads and step grid renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.grid')).toBeVisible();
    // 16 steps × 25 pitch rows = 400 cells in the Phase-0 sequencer.
    // The exact number is locked in here so a future regression that
    // shrinks/grows the grid by accident shows up loud.
    await expect(page.locator('.grid .cell')).toHaveCount(16 * 25);
  });

  test('page is crossOriginIsolated (COOP/COEP headers active)', async ({ page }) => {
    await page.goto('/');
    const isolated = await page.evaluate(() => self.crossOriginIsolated);
    expect(isolated).toBe(true);
  });
});
