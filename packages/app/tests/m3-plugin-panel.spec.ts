import { test, expect, type Page } from '@playwright/test';

// Phase-2 M3 — descriptors render as a host-rendered panel; param edits
// round-trip from the UI through Y.Doc → SAB ring → engine; values
// persist across reload via the IndexedDB-backed Y.Doc.

const SUB_PID_FILTER_CUTOFF = 6;
const SUB_PID_OSC_A_WAVE = 0;

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function trackCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __project: { trackCount: number } };
    return w.__project.trackCount;
  });
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

test.describe('phase-2 / M3 plugin panel (host-rendered descriptors)', () => {
  test('descriptors render as 18 controls grouped by section', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');

    await expect(page.locator('[data-testid="plugin-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid^="param-"][data-testid$="-input"]')).toHaveCount(18);

    for (const g of ['osc', 'filter', 'filter_env', 'amp']) {
      await expect(page.locator(`[data-testid="plugin-group-${g}"]`)).toBeVisible();
    }

    // Wave param is enum-style — renders as a dropdown with the
    // default option "Sine" preselected.
    await expect(page.locator(`[data-testid="param-${SUB_PID_OSC_A_WAVE}-value"]`)).toHaveText('Sine');
  });

  test('cutoff slider edits round-trip Y.Doc → SAB → engine', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const idx = (await trackCount(page)) - 1;

    await expect
      .poll(() => trackParam(page, idx, SUB_PID_FILTER_CUTOFF))
      .toBeCloseTo(2000, 0);

    // Phase-8 M8 — the UI's cutoff control is now a Knob; tests
    // drive the param via __bridge.setSynthParam (Y.Doc path) so
    // the round-trip Y.Doc → SAB → engine still gets exercised.
    await page.evaluate(({ idx, pid }) => {
      (window as any).__bridge.setSynthParam(idx, pid, 8000);
    }, { idx, pid: SUB_PID_FILTER_CUTOFF });

    await expect
      .poll(() => trackParam(page, idx, SUB_PID_FILTER_CUTOFF), { timeout: 3000 })
      .toBeGreaterThan(5000);
  });

  test('param values persist across reload via IndexedDB', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const idx = (await trackCount(page)) - 1;

    // Drive the param to a non-default value via the Y.Doc path
    // (the UI's slider became a Knob in Phase-8 M8; the round-trip
    // we care about is Y.Doc → IndexedDB → reload → engine).
    await page.evaluate(({ idx, pid }) => {
      (window as any).__bridge.setSynthParam(idx, pid, 6000);
    }, { idx, pid: SUB_PID_FILTER_CUTOFF });

    await expect
      .poll(() => trackParam(page, idx, SUB_PID_FILTER_CUTOFF), { timeout: 3000 })
      .toBeGreaterThan(4000);
    const before = await trackParam(page, idx, SUB_PID_FILTER_CUTOFF);

    await page.reload();
    await bridgeReady(page);

    // The synth track should still be there.
    expect(await trackCount(page)).toBeGreaterThan(idx);

    // Select it via the track row to make the panel visible.
    await page.click(`[data-testid="track-row-${idx}"]`);
    await expect(page.locator('[data-testid="plugin-panel"]')).toBeVisible();

    // Engine reflects the persisted value from Y.Doc.
    await expect
      .poll(() => trackParam(page, idx, SUB_PID_FILTER_CUTOFF), { timeout: 3000 })
      .toBeCloseTo(before, 0);
  });
});
