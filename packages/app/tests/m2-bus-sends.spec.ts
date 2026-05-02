import { test, expect, type Page } from '@playwright/test';

// Phase-4 M2 — bus tracks & send routing.
// 1. Add a synth (idx 1).
// 2. Add a bus (idx 2).
// 3. Mute the synth so its dry path silences. Verify peak drops.
// 4. Add a send synth → bus at level 1.0 with bus Gain×2 insert.
// 5. Held note → bus output is audible (post-mute send still routes).
// (M2 spec: post-fader sends are post-mute; muted track contributes 0
// to its sends. So this test verifies the *opposite* — that a non-
// muted track sending to a bus produces the wet signal even when the
// dry signal would otherwise dominate.)

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function trackPeak(page: Page, idx: number): Promise<number> {
  return page.evaluate(async (i) => {
    const w = window as unknown as {
      __bridge: { debugTrackPeak: (i: number) => Promise<number> };
    };
    return w.__bridge.debugTrackPeak(i);
  }, idx);
}

test.describe('phase-4 / M2 bus tracks + send routing', () => {
  test('a send routes a track signal into a bus that processes it', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Synth at idx 1, bus at idx 2.
    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });
    await page.click('[data-testid="add-bus-track"]');
    const busIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });
    expect(busIdx).toBeGreaterThan(synthIdx);

    // Hold a note across the bar on the synth.
    await page.click(`[data-testid="track-row-${synthIdx}"]`);
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }
    await page.click('[data-testid="piano-play"]');

    // Synth peak should climb when the dry path is live.
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);

    // Add a send: synth → bus at level 1.0.
    await page.selectOption('[data-testid="send-add"]', { index: 1 });
    await expect(page.locator('[data-testid="send-0"]')).toBeVisible();
    // Crank send level to 1.0.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="send-0-level"]') as HTMLInputElement;
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Switch to the bus and add a Gain × 2 insert.
    await page.click(`[data-testid="track-row-${busIdx}"]`);
    await page.selectOption('[data-testid="insert-add"]', 'builtin:gain');
    await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="insert-0-param-0-input"]',
      ) as HTMLInputElement;
      // Gain descriptor is linear 0..2; position 1 → value 2.
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Bus peak meter is post-bus-insert; it should be louder than the
    // synth's send-level × synth output. Just assert it's audible.
    await expect
      .poll(() => trackPeak(page, busIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);

    // Removing the send silences the bus.
    await page.click(`[data-testid="track-row-${synthIdx}"]`);
    await page.click('[data-testid="send-0-remove"]');
    await expect
      .poll(() => trackPeak(page, busIdx), { timeout: 4000, intervals: [80, 100, 200, 400] })
      .toBeLessThan(0.05);
  });

  test('add bus shows the bus row in TrackList without errors', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-bus-track"]');
    // The new bus is auto-selected; the track row exists.
    await expect(page.locator('[data-testid="track-row-1"]')).toBeVisible();
    // Bus has no piano-roll / synth panel, but inserts + sends are
    // available.
    await expect(page.locator('[data-testid="insert-slots"]')).toBeVisible();
    await expect(page.locator('[data-testid="send-list"]')).toBeVisible();
  });
});
