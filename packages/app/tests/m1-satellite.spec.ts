import { test, expect, type Page } from '@playwright/test';

// Phase-6 M1+M2 — satellite contract + BroadcastChannel transport.
// The in-page satellite (created via __bridge.createSatelliteForTest)
// shares the BroadcastChannel with root attached in App.svelte. A
// dispatched intent makes the round trip: satellite → channel → root
// intent handler → Y.Doc mutation → snapshot rebuild → engine.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

interface SatHandle {
  dispatch: (intent: { kind: string; [k: string]: unknown }) => void;
  destroy: () => void;
}

test.describe('phase-6 / M1+M2 satellite contract + BroadcastChannel sync', () => {
  test('satellite setMasterGain intent reaches the engine', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { createSatelliteForTest: () => unknown };
      };
      const sat = w.__bridge.createSatelliteForTest() as unknown as SatHandle;
      sat.dispatch({ kind: 'setMasterGain', gain: 0.42 });
      sat.destroy();
    });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { debugMasterGain: () => Promise<number> };
            };
            return w.__bridge.debugMasterGain();
          }),
        { timeout: 3000, intervals: [80, 100, 200] },
      )
      .toBeCloseTo(0.42, 2);
  });

  test('satellite transport intent toggles engine playback', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Add a synth + sustained note so the engine has something to play.
    await page.click('[data-testid="add-synth-track"]');
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }

    await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { createSatelliteForTest: () => unknown };
      };
      const sat = w.__bridge.createSatelliteForTest() as unknown as SatHandle;
      sat.dispatch({ kind: 'transport', play: true });
      sat.destroy();
    });

    // current_tick advances → transport is running.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { debugCurrentTick: () => Promise<number> };
            };
            return w.__bridge.debugCurrentTick();
          }),
        { timeout: 3000, intervals: [80, 100, 200] },
      )
      .toBeGreaterThan(100);
  });
});
