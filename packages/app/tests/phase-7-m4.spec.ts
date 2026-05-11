import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 7 M4 — inspector content + Mixer P4 channel-strip chrome.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('phase-7 M4 — Inspector + P4 Mixer', () => {

  test('inspector shows the selected track identity', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('inspector-stripe')).toBeVisible();
    await expect(page.getByTestId('inspector-name')).toBeVisible();
    await expect(page.getByTestId('inspector-kind')).toBeVisible();
    await expect(page.getByTestId('inspector-insert-count')).toBeVisible();
    await expect(page.getByTestId('inspector-send-count')).toBeVisible();
  });

  test('inspector palette renders 8 swatches and switches the color', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const palette = page.getByTestId('inspector-palette');
    await expect(palette).toBeVisible();
    await expect(palette.locator('button.swatch')).toHaveCount(8);

    // Change the color via the picker and verify the canvas-head
    // stripe + inspector stripe update.
    await page.getByTestId('inspector-swatch-#a06bff').click();
    const inspBg = await page.getByTestId('inspector-stripe').evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const canvasBg = await page.getByTestId('canvas-track-stripe').evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(inspBg).toBe('rgb(160, 107, 255)');
    expect(canvasBg).toBe('rgb(160, 107, 255)');
  });

  test('inspector name input commits on blur', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const name = page.getByTestId('inspector-name');
    await name.fill('Renamed Track');
    await name.blur();
    await expect(page.getByTestId('canvas-track-name')).toHaveText('Renamed Track');
  });

  test('mixer strips render P4 chrome (inserts, sends, pills, dB readout)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('mixer-strip-0')).toBeVisible();
    await expect(page.getByTestId('mixer-inserts-0')).toBeVisible();
    await expect(page.getByTestId('mixer-sends-0')).toBeVisible();
    await expect(page.getByTestId('mixer-solo-0')).toBeVisible();
    await expect(page.getByTestId('mixer-mute-0')).toBeVisible();
    await expect(page.getByTestId('mixer-db-0')).toBeVisible();
  });

  test('mixer dB readout uses mono font', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const family = await page.getByTestId('mixer-db-0').evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(family).toContain('IBM Plex Mono');
  });

  test('master strip has a limiter slot + bigger meter container', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const master = page.getByTestId('mixer-master');
    const strip0 = page.getByTestId('mixer-strip-0');
    const mw = await master.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const sw = await strip0.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(mw).toBeGreaterThan(sw);
    await expect(page.getByTestId('mixer-master-inserts')).toBeVisible();
    await expect(page.getByTestId('mixer-master-db')).toBeVisible();
  });
});
