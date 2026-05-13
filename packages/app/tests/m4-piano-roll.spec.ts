import { test, expect, type Page } from '@playwright/test';

// Phase-2 M4 — PianoRoll clip drives the subtractive synth via the
// track-level clip scheduler. Add a synth track, paint four notes on
// the grid, hit play, the engine peak meter on the track climbs.

const SUB_PID_FILTER_CUTOFF = 6;

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

async function trackParam(page: Page, track: number, paramId: number): Promise<number> {
  return page.evaluate(
    ({ t, p }) => {
      const w = window as unknown as {
        __bridge: { debugTrackParam: (t: number, p: number) => Promise<number> };
      };
      return w.__bridge.debugTrackParam(t, p);
    },
    { t: track, p: paramId },
  );
}

test.describe('phase-2 / M4 piano-roll clip + scheduler', () => {
  test('painting notes on the synth piano-roll produces audio when played', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Piano-roll grid mounts.
    const grid = page.locator(`[data-testid="piano-grid-${synthIdx}"]`);
    await expect(grid).toBeVisible();

    // Paint a 4-note arpeggio at columns 0/4/8/12 with pitches C4/E4/G4/C5.
    // MIDI numbers: 60, 64, 67, 72.
    const notes: [number, number][] = [
      [60, 0],
      [64, 4],
      [67, 8],
      [72, 12],
    ];
    for (const [pitch, col] of notes) {
      await page.click(`[data-testid="piano-cell-${pitch}-${col}"]`);
    }

    // Cells light up (visible feedback that the Y.Doc accepted the
    // edit and the component re-rendered).
    for (const [pitch, col] of notes) {
      await expect(page.locator(`[data-testid="piano-cell-${pitch}-${col}"]`)).toHaveClass(/on/);
    }

    // Hit play. Engine peak on the synth track climbs above the noise
    // floor as the scheduler fires NoteOn into the synth.
    await page.click('button.play');
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);
  });

  test('removing a piano-roll note silences it on the next playthrough', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Add → click again toggles off.
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect(page.locator('[data-testid="piano-cell-60-0"]')).toHaveClass(/on/);

    await page.click('[data-testid="piano-cell-60-0"]');
    await expect(page.locator('[data-testid="piano-cell-60-0"]')).not.toHaveClass(/on/);

    // Engine should not produce sound when there are no notes.
    await page.click('button.play');
    // Give the engine a moment to process the empty schedule.
    await page.waitForTimeout(400);
    expect(await trackPeak(page, synthIdx)).toBeLessThan(0.05);
  });

  test('cutting filter cutoff during playback drops the synth peak', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Open a sustained note across the bar so the track is loud.
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }

    await page.click('button.play');

    // Engine produces audible peak.
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);

    // Cut cutoff way down — engine peak drops as the LP filter
    // chokes the note. Use the Y.Doc backdoor since the UI control
    // moved from a range input to a Knob in Phase-8 M8.
    await page.evaluate(({ idx, pid }) => {
      (window as any).__bridge.setSynthParam(idx, pid, 20);
    }, { idx: synthIdx, pid: SUB_PID_FILTER_CUTOFF });

    await expect
      .poll(() => trackParam(page, synthIdx, SUB_PID_FILTER_CUTOFF), { timeout: 3000 })
      .toBeLessThan(50);
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 100, 200] })
      .toBeLessThan(0.02);
  });
});
