import { test, expect, type Page } from '@playwright/test';

// Phase-3 M4 — basic MIDI Learn. Toggle learn mode → simulate a CC#
// from "hardware" → click a target param → toggle learn off → assert
// further CC messages on that number sweep the bound parameter.

const PID_FILTER_CUTOFF = 6;

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
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

async function simulateCc(page: Page, cc: number, value: number) {
  await page.evaluate(
    ({ c, v }) => {
      const w = window as unknown as { __bridge: { midiSimulate: (data: number[]) => void } };
      w.__bridge.midiSimulate([0xb0, c, v]);
    },
    { c: cc, v: value },
  );
}

test.describe('phase-3 / M4 MIDI Learn', () => {
  test('binding CC#74 to filter cutoff sweeps the engine param', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Toggle Learn on; the toolbar reflects state.
    await page.click('[data-testid="midi-learn-toggle"]');
    await expect(page.locator('[data-testid="midi-learn-toggle"]')).toHaveClass(/active/);

    // "Hardware controller" emits CC#74 (the canonical filter-cutoff
    // CC on most MIDI keyboards). The captured CC# becomes pendingCC
    // and the toolbar prompts the user to click a target.
    await simulateCc(page, 74, 64);
    await expect(page.locator('[data-testid="midi-learn-toggle"]')).toContainText('CC74');

    // Click the filter cutoff control's learn target — commits the
    // binding to the Y.Doc.
    await page.click(`[data-testid="param-${PID_FILTER_CUTOFF}-learn"]`);

    // The cutoff control now displays a CC74 chip.
    await expect(page.locator(`[data-testid="param-${PID_FILTER_CUTOFF}-cc"]`)).toContainText('CC74');

    // Toggle Learn off.
    await page.click('[data-testid="midi-learn-toggle"]');
    await expect(page.locator('[data-testid="midi-learn-toggle"]')).not.toHaveClass(/active/);

    // Now hardware CC#74 messages drive the bound param. Bottom of
    // the range → cutoff falls to ~20 Hz. Top → ~20 kHz.
    await simulateCc(page, 74, 0);
    await expect.poll(() => trackParam(page, synthIdx, PID_FILTER_CUTOFF), { timeout: 3000 })
      .toBeLessThan(50);

    await simulateCc(page, 74, 127);
    await expect.poll(() => trackParam(page, synthIdx, PID_FILTER_CUTOFF), { timeout: 3000 })
      .toBeGreaterThan(15_000);
  });

  test('unbinding via the CC chip clears the binding', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Bind CC#74 → cutoff (same setup as the first test).
    await page.click('[data-testid="midi-learn-toggle"]');
    await simulateCc(page, 74, 64);
    await page.click(`[data-testid="param-${PID_FILTER_CUTOFF}-learn"]`);
    await page.click('[data-testid="midi-learn-toggle"]');

    // Drive CC74 to a known value, then unbind, then drive it again
    // — engine param should NOT change after unbind.
    await simulateCc(page, 74, 127);
    await expect.poll(() => trackParam(page, synthIdx, PID_FILTER_CUTOFF), { timeout: 3000 })
      .toBeGreaterThan(15_000);
    const high = await trackParam(page, synthIdx, PID_FILTER_CUTOFF);

    // Click the chip to unbind.
    await page.click(`[data-testid="param-${PID_FILTER_CUTOFF}-cc"]`);
    await expect(page.locator(`[data-testid="param-${PID_FILTER_CUTOFF}-cc"]`)).toHaveCount(0);

    // CC#74 is no longer routed; engine value stays at the last
    // bound write.
    await simulateCc(page, 74, 0);
    // Give a beat for any propagation that *would* happen to land.
    await page.waitForTimeout(150);
    expect(await trackParam(page, synthIdx, PID_FILTER_CUTOFF)).toBeCloseTo(high, 0);
  });
});
