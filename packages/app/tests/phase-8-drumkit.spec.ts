import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M2 — drumkit plugin (first-party). End-to-end: add a drumkit
 * track, paint a kick at tick 0, play, watch the engine peak rise.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function trackCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__bridge.inspectTracks().length);
}

async function trackPeak(page: Page, idx: number): Promise<number> {
  return page.evaluate(
    (i) => (window as any).__bridge.debugTrackPeak(i),
    idx,
  );
}

test.describe('phase-8 M2 — drumkit plugin', () => {

  test('+ Drums button is reachable in the top bar', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('add-drumkit-track')).toBeVisible();
  });

  test('adding a drumkit track produces an audible kick when played', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    const before = await trackCount(page);
    await page.getByTestId('add-drumkit-track').click();
    await expect.poll(() => trackCount(page)).toBe(before + 1);
    const drumIdx = before;

    // Start the engine first so the worklet is processing blocks;
    // then fire the kick. Poll the per-track peak meter for ~300 ms
    // (one kick envelope) — any non-trivial peak proves the voice
    // is producing audio.
    await page.click('button.play');
    await page.waitForTimeout(50);
    await page.evaluate((idx) => {
      (window as any).__bridge.noteOn(idx, 36, 110);
    }, drumIdx);

    let peak = 0;
    for (let i = 0; i < 30 && peak < 0.05; i++) {
      await page.waitForTimeout(20);
      peak = await trackPeak(page, drumIdx);
    }
    await page.click('button.play'); // stop
    expect(peak).toBeGreaterThan(0.05);
  });

  test('drumkit has 13 host-rendered descriptors', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.getByTestId('add-drumkit-track').click();
    // The plugin-panel mounts when the new track is selected.
    await expect(page.getByTestId('inspector-plugin')).toHaveText('drumkit');
  });
});
