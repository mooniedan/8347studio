import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/mixer.md.
 *
 * The bottom drawer mixer is reachable, a strip exists per track,
 * the master strip is present, and the popout button is wired.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / mixer — bottom drawer + channel strips', () => {

  // "The bottom drawer holds the mixer."
  test('mixer is mounted with one strip per track + a master strip', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Default project has 1 track → 1 strip + master.
    await expect(page.getByTestId('mixer')).toBeVisible();
    await expect(page.getByTestId('mixer-strip-0')).toBeVisible();
    await expect(page.getByTestId('mixer-master')).toBeVisible();
  });

  // "Each strip has, top to bottom: Color stripe + name, Insert FX
  //  slots, Sends, Pan, Fader + meter, S/M pills, dB readout."
  test('each strip exposes the documented controls', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('mixer-inserts-0')).toBeVisible();
    await expect(page.getByTestId('mixer-sends-0')).toBeVisible();
    await expect(page.getByTestId('mixer-pan-0')).toBeVisible();
    await expect(page.getByTestId('mixer-gain-0')).toBeVisible();
    await expect(page.getByTestId('mixer-meter-0')).toBeVisible();
    await expect(page.getByTestId('mixer-db-0')).toBeVisible();
  });

  // "The Master strip on the right is wider and reserves a slot for
  //  a master limiter."
  test('master strip has its own insert slot + meter + dB readout', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('mixer-master-inserts')).toBeVisible();
    await expect(page.getByTestId('mixer-master-gain')).toBeVisible();
    await expect(page.getByTestId('mixer-master-meter')).toBeVisible();
    await expect(page.getByTestId('mixer-master-db')).toBeVisible();
  });

  // "Click the ⤴ icon at the top of the drawer."
  test('popout button is wired (testid mixer-popout)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('mixer-popout')).toBeVisible();
  });
});
