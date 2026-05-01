import { test, expect, type Page } from '@playwright/test';

// Phase-3 M1 — WebMIDI plumbing. We test the decode path end-to-end
// (raw 3-byte status messages → bridge → engine voice) via a test
// backdoor that bypasses requestMIDIAccess. The real MIDI permission
// flow is exercised manually with hardware; the plumbing it leans on
// (the dispatch + bridge.noteOn path) is what regresses if any of M1
// breaks.

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

test.describe('phase-3 / M1 WebMIDI plumbing', () => {
  test('a NoteOn 0x90 60 100 message reaches the synth and produces audio', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Add a synth track and select it (App routes MIDI to the
    // selected track until M2 swaps to armed-track routing).
    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Simulate a NoteOn (status 0x90, channel 0, pitch 60, velocity 100).
    await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { midiSimulate: (data: number[]) => void };
      };
      w.__bridge.midiSimulate([0x90, 60, 100]);
    });

    // Engine track peak climbs above the noise floor: a voice fired.
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);
  });

  test('NoteOn velocity 0 is treated as NoteOff (running-status compat)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Trigger note → velocity 0 message → expect note to release.
    await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { midiSimulate: (data: number[]) => void };
      };
      w.__bridge.midiSimulate([0x90, 60, 100]);
    });
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 3000 })
      .toBeGreaterThan(0.05);

    await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { midiSimulate: (data: number[]) => void };
      };
      // 0x90 60 0 → canonical "note-off via velocity-0" form.
      w.__bridge.midiSimulate([0x90, 60, 0]);
    });

    // After release, peak decays back below the noise floor.
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 100, 200, 400] })
      .toBeLessThan(0.05);
  });

  test('explicit NoteOff 0x80 releases a held voice', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { midiSimulate: (data: number[]) => void };
      };
      w.__bridge.midiSimulate([0x90, 64, 100]);
    });
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 3000 })
      .toBeGreaterThan(0.05);

    await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { midiSimulate: (data: number[]) => void };
      };
      w.__bridge.midiSimulate([0x80, 64, 0]);
    });
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 100, 200, 400] })
      .toBeLessThan(0.05);
  });

  test('idle MIDI chip renders an Enable MIDI button', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // The chip starts in idle and surfaces an Enable affordance — this
    // is the only piece of MIDI UI we test in Playwright. The actual
    // permission grant requires a user-gesture API and a host with
    // WebMIDI; both are manual-test territory.
    await expect(page.locator('[data-testid="enable-midi"]')).toBeVisible();
  });
});
