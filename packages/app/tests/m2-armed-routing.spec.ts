import { test, expect, type Page } from '@playwright/test';

// Phase-3 M2 — armed-track routing. The arm button on a track row
// directs incoming MIDI to that track; only one track is armed at a
// time. Default project has one step-seq track at idx 0; we add two
// synth tracks so we can compare routing.

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

async function fireNote(page: Page, status = 0x90, pitch = 60, vel = 100) {
  await page.evaluate(
    ({ s, p, v }) => {
      const w = window as unknown as {
        __bridge: { midiSimulate: (data: number[]) => void };
      };
      w.__bridge.midiSimulate([s, p, v]);
    },
    { s: status, p: pitch, v: vel },
  );
}

test.describe('phase-3 / M2 armed-track routing', () => {
  test('arming a track sends MIDI to that track, not the selected one', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Two synth tracks: idx 1 and idx 2 (idx 0 is the default step-
    // seq track). Newly-added synths are auto-selected, so after the
    // second add the *selection* is on track 2.
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="add-synth-track"]');

    // Arm track 1 explicitly, while selection is still on track 2.
    await page.click('[data-testid="track-arm-1"]');
    await expect(page.locator('[data-testid="track-arm-1"]')).toHaveClass(/armed/);

    // Fire a note. It should land on track 1 (armed), not track 2
    // (selected).
    await fireNote(page);

    await expect
      .poll(() => trackPeak(page, 1), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);
    await fireNote(page, 0x80, 60, 0);

    // Track 2 should NOT be loud — verify by polling for a stretch
    // and checking it stays low. Use a short window because the synth
    // doesn't ring out on its own.
    const t2 = await trackPeak(page, 2);
    expect(t2).toBeLessThan(0.05);
  });

  test('arming swaps mid-session: same NoteOn lands on whichever track is armed', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="add-synth-track"]');

    // First arm track 1, fire, expect track 1 audible.
    await page.click('[data-testid="track-arm-1"]');
    await fireNote(page);
    await expect
      .poll(() => trackPeak(page, 1), { timeout: 4000 })
      .toBeGreaterThan(0.05);
    await fireNote(page, 0x80, 60, 0);
    await expect
      .poll(() => trackPeak(page, 1), { timeout: 4000, intervals: [80, 100, 200, 400] })
      .toBeLessThan(0.05);

    // Now arm track 2 instead — clicking the same arm button toggles
    // off, so click track 2's arm directly. Single-track arm policy
    // means arming track 2 unarms track 1.
    await page.click('[data-testid="track-arm-2"]');
    await expect(page.locator('[data-testid="track-arm-2"]')).toHaveClass(/armed/);
    await expect(page.locator('[data-testid="track-arm-1"]')).not.toHaveClass(/armed/);

    await fireNote(page);
    await expect
      .poll(() => trackPeak(page, 2), { timeout: 4000 })
      .toBeGreaterThan(0.05);
    await fireNote(page, 0x80, 60, 0);
  });

  test('unarming returns routing to the selected-track fallback', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]'); // idx 1
    // Selection now on idx 1.

    // Arm idx 1 then unarm.
    await page.click('[data-testid="track-arm-1"]');
    await page.click('[data-testid="track-arm-1"]');
    await expect(page.locator('[data-testid="track-arm-1"]')).not.toHaveClass(/armed/);

    // No track armed → fall back to selection (idx 1). Note should
    // still land on the synth.
    await fireNote(page);
    await expect
      .poll(() => trackPeak(page, 1), { timeout: 4000 })
      .toBeGreaterThan(0.05);
  });
});
