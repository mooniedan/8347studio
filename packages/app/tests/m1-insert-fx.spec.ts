import { test, expect, type Page } from '@playwright/test';

// Phase-4 M1 — insert FX chain. Add a Gain insert on a synth track,
// drop the gain to 0 → engine peak falls. Bypass it → peak restored.

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

test.describe('phase-4 / M1 insert FX chain', () => {
  test('a Gain insert at 0 silences the track; bypass restores it', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Hold a sustained note across the bar — the track is loud.
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }
    await page.click('[data-testid="piano-play"]');

    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);

    // Add a Gain insert on this track.
    await page.selectOption('[data-testid="insert-add"]', 'builtin:gain');
    await expect(page.locator('[data-testid="insert-slot-0"]')).toBeVisible();

    // Pull the slot's gain to 0.
    await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="insert-0-param-0-input"]',
      ) as HTMLInputElement;
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Engine peak collapses — the insert chain attenuates the signal
    // before it reaches the meter (which sits *after* inserts).
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 100, 200] })
      .toBeLessThan(0.02);

    // Bypass the insert — peak climbs back.
    await page.click('[data-testid="insert-0-bypass"]');
    await expect(page.locator('[data-testid="insert-0-bypass"]')).toHaveClass(/on/);
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 100, 200] })
      .toBeGreaterThan(0.05);
  });

  test('removing an insert clears it from the chain', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');

    // Add two Gain inserts.
    await page.selectOption('[data-testid="insert-add"]', 'builtin:gain');
    await page.selectOption('[data-testid="insert-add"]', 'builtin:gain');
    await expect(page.locator('[data-testid^="insert-slot-"]')).toHaveCount(2);

    // Remove the first.
    await page.click('[data-testid="insert-0-remove"]');
    await expect(page.locator('[data-testid^="insert-slot-"]')).toHaveCount(1);
  });
});
