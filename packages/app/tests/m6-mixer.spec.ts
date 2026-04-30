import { test, expect, type Page } from '@playwright/test';

// M6 verifies the mixer per-track meter responds to gain changes.
// Light up a few cells on track 0, hit play, wait for the engine peak
// meter to climb. Drag mixer gain to 0 → meter falls. Restore → climbs.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function trackPeak(page: Page, idx = 0): Promise<number> {
  return page.evaluate(async (i) => {
    const w = window as unknown as { __bridge: { debugTrackPeak: (i: number) => Promise<number> } };
    return w.__bridge.debugTrackPeak(i);
  }, idx);
}

async function setMixerGain(page: Page, track: number, value: number) {
  await page.evaluate(({ t, v }) => {
    const el = document.querySelector(`[data-testid="mixer-gain-${t}"]`) as HTMLInputElement;
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { t: track, v: value });
}

test.describe('phase-1 / M6 mixer', () => {
  test('track meter responds to gain edits in the mixer', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Light four cells on track 0 — every fourth step.
    for (const i of [0, 4, 8, 12]) {
      await page.locator('[data-testid="grid-0"] .cell').nth(i).click();
    }

    await page.click('button.play');

    // Engine starts producing audio; peak climbs above noise floor.
    await expect.poll(() => trackPeak(page, 0), { timeout: 4000, intervals: [80, 80, 120] }).toBeGreaterThan(0.05);

    // Mixer fader to 0 → engine peak drops.
    await setMixerGain(page, 0, 0);
    await expect.poll(() => trackPeak(page, 0), { timeout: 3000, intervals: [80, 80, 200] }).toBeLessThan(0.02);

    // Restore fader → peak climbs again.
    await setMixerGain(page, 0, 1);
    await expect.poll(() => trackPeak(page, 0), { timeout: 3000, intervals: [80, 80, 200] }).toBeGreaterThan(0.05);
  });
});
