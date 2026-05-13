import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M5b — plugin persistence + boot-time re-registration.
 *
 * Installed plugins live in Y.Doc `meta.installedPlugins`. On boot
 * the app walks that map, re-fetches each manifest's wasm, verifies
 * integrity, re-registers with the worklet, and rebinds insert slots
 * by stable manifest id. Failures surface as a red "FAILED" badge on
 * the picker card; they don't take down audio.
 */

const BITCRUSHER_MANIFEST_URL = '/example-plugins/wasm_bitcrusher.json';

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function inspectTracks(page: Page) {
  return page.evaluate(() => (window as any).__bridge.inspectTracks());
}

async function trackPeak(page: Page, idx: number): Promise<number> {
  return page.evaluate(
    (i) => (window as any).__bridge.debugTrackPeak(i),
    idx,
  );
}

test.describe('phase-8 M5b — plugin persistence', () => {

  test('installed plugins survive a page reload', async ({ page }) => {
    test.setTimeout(25_000);
    await page.goto('/');
    await bridgeReady(page);

    // Install via the picker.
    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('plugin-url-input').fill(BITCRUSHER_MANIFEST_URL);
    await page.getByTestId('plugin-install').click();
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible();
    await page.getByTestId('plugin-picker-close').click();

    // Reload — the worklet starts fresh, but reloadInstalledPlugins
    // walks meta.installedPlugins, re-fetches the wasm, and re-
    // registers with a brand-new handle. The picker card comes back.
    await page.reload();
    await bridgeReady(page);
    await page.getByTestId('open-plugin-picker').click();
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible();
    // No failure badge: the SRI hash + URL still match.
    await expect(page.getByTestId('plugin-card-failed-com.example.bitcrusher')).toHaveCount(0);
  });

  test('insert slots rebind to a freshly-registered handle on reload', async ({ page }) => {
    test.setTimeout(25_000);
    await page.goto('/');
    await bridgeReady(page);

    // Add a synth track, install the bitcrusher, attach it.
    await page.getByTestId('add-synth-track').click();
    const trackIdx = await page.evaluate(() => (window as any).__bridge.inspectTracks().length - 1);

    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('plugin-url-input').fill(BITCRUSHER_MANIFEST_URL);
    await page.getByTestId('plugin-install').click();
    await page.getByTestId('plugin-add-com.example.bitcrusher').click();

    // Insert is on the track.
    const beforeReload = await inspectTracks(page);
    expect(beforeReload[trackIdx].inserts.map((i: { kind: string }) => i.kind)).toContain('wasm');

    // Reload. The handle is regenerated, but the slot references
    // the plugin by manifest id — engine-bridge resolves via the
    // new handle automatically.
    await page.reload();
    await bridgeReady(page);

    const afterReload = await inspectTracks(page);
    expect(afterReload[trackIdx].inserts.map((i: { kind: string }) => i.kind)).toContain('wasm');

    // Audio still flows through the rebound plugin — peak responds
    // when a synth voice fires.
    await page.evaluate((i) => (window as any).__bridge.noteOn(i, 60, 110), trackIdx);
    await page.click('button.play');
    await page.waitForTimeout(250);
    const peak = await trackPeak(page, trackIdx);
    await page.click('button.play');
    expect(peak).toBeGreaterThan(0.01);
  });

  test('failed re-registration surfaces a "FAILED" badge without crashing', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    // Inject a persisted manifest entry that points at a non-
    // existent wasm. Bypasses the install path so we don't need a
    // network failure injector.
    await page.evaluate(() => {
      const w = window as any;
      const proj = w.__project;
      void proj;
    });
    // We need to write into meta.installedPlugins; the bridge
    // doesn't expose that directly. Use the Y.Doc by reaching
    // through the engine's __bridge — we expose a tiny test helper
    // below for this.
    await page.evaluate(() => {
      const b = (window as any).__bridge;
      const broken = {
        id: 'com.example.broken',
        name: 'Broken Plugin',
        version: '0.1.0',
        kind: 'effect',
        wasm: '/does-not-exist.wasm',
        wasmIntegrity: 'sha256-' + 'X'.repeat(43) + '=',
        params: [],
      };
      b._testRecordInstalledPlugin?.('com.example.broken', JSON.stringify(broken));
    });
    // y-indexeddb flushes asynchronously; give it a moment so the
    // write hits disk before the reload.
    await page.waitForTimeout(300);

    await page.reload();
    await bridgeReady(page);
    await page.getByTestId('open-plugin-picker').click();
    await expect(page.getByTestId('plugin-card-com.example.broken')).toBeVisible();
    await expect(page.getByTestId('plugin-card-failed-com.example.broken')).toBeVisible();
    await expect(page.getByTestId('plugin-card-error-com.example.broken')).toBeVisible();
    // The "Add to track" button is disabled when the plugin failed.
    await expect(page.getByTestId('plugin-add-com.example.broken')).toBeDisabled();
  });
});
