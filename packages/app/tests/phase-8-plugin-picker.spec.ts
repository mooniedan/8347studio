import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M5 — plugin picker UI. End-to-end:
 *  - "+ Plugin" opens the picker modal.
 *  - Browse tab accepts a manifest URL and installs the plugin.
 *  - Installed tab shows the loaded plugin and lets the user add
 *    it to the selected track as an insert.
 *  - Bad manifest URL surfaces an error in the picker (no crash).
 */

const BITCRUSHER_MANIFEST_URL = '/example-plugins/wasm_bitcrusher.json';

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function inspectTracks(page: Page) {
  return page.evaluate(() => (window as any).__bridge.inspectTracks());
}

test.describe('phase-8 M5 — plugin picker', () => {

  test('+ Plugin opens the picker; Installed tab is empty initially', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await expect(page.getByTestId('open-plugin-picker')).toBeVisible();
    await page.getByTestId('open-plugin-picker').click();

    await expect(page.getByTestId('plugin-picker')).toBeVisible();
    await expect(page.getByTestId('plugin-picker-empty')).toBeVisible();
    // The close button works.
    await page.getByTestId('plugin-picker-close').click();
    await expect(page.getByTestId('plugin-picker')).not.toBeVisible();
  });

  test('install-from-URL fetches + verifies + registers the plugin', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    await page.getByTestId('open-plugin-picker').click();
    // Switch to the Browse / Install tab.
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('plugin-url-input').fill(BITCRUSHER_MANIFEST_URL);
    await page.getByTestId('plugin-install').click();

    // After install, the picker flips back to Installed and shows
    // a card for the bitcrusher.
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible();
    await expect(page.getByTestId('plugin-add-com.example.bitcrusher')).toBeVisible();
  });

  test('add-to-track puts the plugin on the selected track', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    // Select track 1 (the default project's Sequencer track) by
    // adding a fresh synth that will become track 1.
    await page.getByTestId('add-synth-track').click();
    const trackIdx = await page.evaluate(() => (window as any).__bridge.inspectTracks().length - 1);
    expect(trackIdx).toBeGreaterThan(0);

    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('plugin-url-input').fill(BITCRUSHER_MANIFEST_URL);
    await page.getByTestId('plugin-install').click();
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible();

    // Add to the selected track.
    await page.getByTestId('plugin-add-com.example.bitcrusher').click();

    // Picker closes after adding; the track gains a wasm insert.
    await expect(page.getByTestId('plugin-picker')).not.toBeVisible();
    const tracks = await inspectTracks(page);
    const inserts = tracks[trackIdx].inserts.map((i: { kind: string }) => i.kind);
    expect(inserts).toContain('wasm');
  });

  test('bad manifest URL surfaces an error in the picker', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('plugin-url-input').fill('/nope.json');
    await page.getByTestId('plugin-install').click();
    await expect(page.getByTestId('plugin-install-error')).toBeVisible();
    // The vite dev server's SPA fallback returns 200 + index.html for
    // unknown paths so `fetch.ok` is true and we end up surfacing the
    // JSON-parse failure instead of a 404. Either is a fine signal
    // that "this URL isn't a plugin manifest."
    await expect(page.getByTestId('plugin-install-error'))
      .toContainText(/fetch failed|404|invalid manifest|invalid JSON/i);
  });

  test('installing the same plugin twice is idempotent', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('plugin-url-input').fill(BITCRUSHER_MANIFEST_URL);
    await page.getByTestId('plugin-install').click();
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible();

    // Try again — surfaces the duplicate error, no second card.
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('plugin-url-input').fill(BITCRUSHER_MANIFEST_URL);
    await page.getByTestId('plugin-install').click();
    await expect(page.getByTestId('plugin-install-error')).toContainText(/already installed/i);

    // Switch back to Installed to verify the card count.
    await page.getByTestId('plugin-picker-tabs-installed').click();
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toHaveCount(1);
  });
});
