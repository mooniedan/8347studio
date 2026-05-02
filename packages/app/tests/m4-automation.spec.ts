import { test, expect, type Page } from '@playwright/test';

// Phase-4 M4 — automation lanes. Today we expose the data path via
// __bridge.addAutomationPoint and verify the engine evaluates the
// lane each block: locate the playhead inside the lane and read back
// the bound parameter via debug_track_param.

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

test.describe('phase-4 / M4 automation lanes', () => {
  test('a 100→8000 Hz cutoff lane sweeps the synth filter during playback', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Add automation: cutoff 100 Hz at tick 0, 8000 Hz at tick 3840
    // (one bar at 120 BPM, ppq=960).
    await page.evaluate(
      ({ idx, paramId }) => {
        const w = window as unknown as {
          __bridge: {
            addAutomationPoint: (
              trackIdx: number,
              target: 'instrument' | 'insert',
              slotIdx: number,
              paramId: number,
              tick: number,
              value: number,
            ) => void;
          };
        };
        w.__bridge.addAutomationPoint(idx, 'instrument', 0, paramId, 0, 100);
        w.__bridge.addAutomationPoint(idx, 'instrument', 0, paramId, 3840, 8000);
      },
      { idx: synthIdx, paramId: PID_FILTER_CUTOFF },
    );

    // Hold a sustained note so the synth is producing audio.
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }

    // Start playback. Engine ticks from 0; the lane's first block
    // pushes cutoff toward 100 Hz.
    await page.click('[data-testid="piano-play"]');

    // Poll cutoff: it should pass through the high range as the bar
    // progresses (ticks 0..3840 → cutoff 100..8000). Wait for the
    // late-bar moment when cutoff is large.
    await expect
      .poll(() => trackParam(page, synthIdx, PID_FILTER_CUTOFF), {
        timeout: 4000,
        intervals: [80, 100, 200, 400],
      })
      .toBeGreaterThan(4000);
  });

  test('removing all points clears the lane', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    await page.evaluate(
      ({ idx, paramId }) => {
        const w = window as unknown as {
          __bridge: {
            addAutomationPoint: (
              trackIdx: number,
              target: 'instrument' | 'insert',
              slotIdx: number,
              paramId: number,
              tick: number,
              value: number,
            ) => void;
            listAutomationLanes: () => unknown[];
          };
        };
        w.__bridge.addAutomationPoint(idx, 'instrument', 0, paramId, 0, 1000);
      },
      { idx: synthIdx, paramId: PID_FILTER_CUTOFF },
    );

    let lanes = await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { listAutomationLanes: () => unknown[] };
      };
      return w.__bridge.listAutomationLanes();
    });
    expect(lanes.length).toBe(1);

    await page.evaluate(
      ({ idx, paramId }) => {
        const w = window as unknown as {
          __bridge: {
            removeAutomationPoint: (
              trackIdx: number,
              target: 'instrument' | 'insert',
              slotIdx: number,
              paramId: number,
              pointIdx: number,
            ) => void;
          };
        };
        w.__bridge.removeAutomationPoint(idx, 'instrument', 0, paramId, 0);
      },
      { idx: synthIdx, paramId: PID_FILTER_CUTOFF },
    );

    lanes = await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { listAutomationLanes: () => unknown[] };
      };
      return w.__bridge.listAutomationLanes();
    });
    expect(lanes.length).toBe(0);
  });
});
