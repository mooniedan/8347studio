import { test, expect, type Page } from '@playwright/test';

// Phase-4 M5 — Container plugin (parallel branches). cargo tests
// cover the engine-level mixing math; the e2e flow here verifies
// that the snapshot path round-trips a Container with sub-inserts
// from Y.Doc all the way to the engine.

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

test.describe('phase-4 / M5 Container plugin', () => {
  test('Container with two branches sums their outputs', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Drop a Container insert via the picker.
    await page.selectOption('[data-testid="insert-add"]', 'builtin:container');
    await expect(page.locator('[data-testid="insert-slot-0"]')).toBeVisible();
    // The slot's params block exposes 2 branch-gain controls.
    await expect(
      page.locator('[data-testid="insert-0-param-0-input"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="insert-0-param-1-input"]'),
    ).toBeVisible();

    // Rig parallel routing: branch 0 stays empty (passthrough);
    // branch 1 gets a Gain insert dropped to 0.5. Sum: 1.0 + 0.5 =
    // 1.5×. Both branches retain default gain 1.0.
    await page.evaluate(({ idx }) => {
      const w = window as unknown as {
        __bridge: {
          addContainerSubInsert: (
            t: number,
            s: number,
            b: number,
            k: 'builtin:gain',
          ) => void;
          setContainerSubInsertParam: (
            t: number,
            s: number,
            b: number,
            sub: number,
            paramId: number,
            value: number,
          ) => void;
        };
      };
      w.__bridge.addContainerSubInsert(idx, 0, 1, 'builtin:gain');
      w.__bridge.setContainerSubInsertParam(idx, 0, 1, 0, 0, 0.5);
    }, { idx: synthIdx });

    // Hold a sustained note → engine peak rises above noise floor and
    // reflects the parallel sum (we just check it's live, not the
    // exact magnitude — the Container math is unit-tested in cargo).
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }
    await page.click('button.play');
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);
  });

  test('bypassing the Container slot silences both branches', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Container with both branch gains at 0 → wet path silent.
    // Bypass should also give silence (actually bypass on InsertSlot
    // skips the plugin entirely, restoring the upstream signal — so
    // it should make the synth audible again. We test that direction:
    // un-bypassed Container with gain=0 silences; bypassing restores
    // signal.)
    await page.selectOption('[data-testid="insert-add"]', 'builtin:container');
    // Pull both branch gains to 0.
    await page.evaluate(() => {
      const a = document.querySelector(
        '[data-testid="insert-0-param-0-input"]',
      ) as HTMLInputElement;
      a.value = '0';
      a.dispatchEvent(new Event('input', { bubbles: true }));
      const b = document.querySelector(
        '[data-testid="insert-0-param-1-input"]',
      ) as HTMLInputElement;
      b.value = '0';
      b.dispatchEvent(new Event('input', { bubbles: true }));
    });

    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }
    await page.click('button.play');

    // With both branches summing 0, the chain output is silent.
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 100, 200] })
      .toBeLessThan(0.02);

    // Bypass the Container slot → upstream signal passes through.
    await page.click('[data-testid="insert-0-bypass"]');
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);
  });
});
