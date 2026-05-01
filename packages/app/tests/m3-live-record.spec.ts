import { test, expect, type Page } from '@playwright/test';

// Phase-3 M3 — live record. Toggle record, fire mock MIDI notes, stop,
// assert the armed track's piano-roll clip now holds those notes.
// Test runs without playback (the engine is on but transport is
// stopped); recording is wall-clock based, so notes commit fine.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

interface Bridge {
  midiSimulate: (data: number[]) => void;
  isRecording: () => boolean;
  getPianoRollNotes: (trackIdx: number) => {
    pitch: number;
    velocity: number;
    startTick: number;
    lengthTicks: number;
  }[];
}

async function getNotes(page: Page, idx: number) {
  return page.evaluate((i) => {
    const w = window as unknown as { __bridge: Bridge };
    return w.__bridge.getPianoRollNotes(i);
  }, idx);
}

async function fireMidi(page: Page, status: number, pitch: number, vel: number) {
  await page.evaluate(
    ({ s, p, v }) => {
      const w = window as unknown as { __bridge: Bridge };
      w.__bridge.midiSimulate([s, p, v]);
    },
    { s: status, p: pitch, v: vel },
  );
}

test.describe('phase-3 / M3 live record into PianoRoll clip', () => {
  test('records live MIDI notes into the armed track on stop', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });
    // Arm the synth so live-record knows where to commit.
    await page.click(`[data-testid="track-arm-${synthIdx}"]`);

    // Empty before recording.
    expect((await getNotes(page, synthIdx)).length).toBe(0);

    // Start record. Fire C4, wait, NoteOff. Fire E4, wait, NoteOff.
    await page.click('[data-testid="record"]');
    await expect(page.locator('[data-testid="record"]')).toHaveClass(/recording/);

    await fireMidi(page, 0x90, 60, 100);
    await page.waitForTimeout(120);
    await fireMidi(page, 0x80, 60, 0);

    await page.waitForTimeout(50);
    await fireMidi(page, 0x90, 64, 100);
    await page.waitForTimeout(120);
    await fireMidi(page, 0x80, 64, 0);

    // Stop recording — commits the buffer to the clip.
    await page.click('[data-testid="record"]');
    await expect(page.locator('[data-testid="record"]')).not.toHaveClass(/recording/);

    const notes = await getNotes(page, synthIdx);
    expect(notes.length).toBe(2);
    // Sort by startTick — capture order may not match commit order if
    // Y.Array iteration shifts; pitches are what matter for the M3
    // headline.
    notes.sort((a, b) => a.startTick - b.startTick);
    expect(notes[0].pitch).toBe(60);
    expect(notes[1].pitch).toBe(64);
    // Notes should have non-zero length (NoteOff arrived).
    for (const n of notes) {
      expect(n.lengthTicks).toBeGreaterThan(0);
    }
    // Second note's startTick is later than first's.
    expect(notes[1].startTick).toBeGreaterThan(notes[0].startTick);
  });

  test('record without an armed track is a no-op', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });
    // Do NOT arm.

    await page.click('[data-testid="record"]');
    await fireMidi(page, 0x90, 60, 100);
    await page.waitForTimeout(50);
    await fireMidi(page, 0x80, 60, 0);
    await page.click('[data-testid="record"]');

    // No notes committed.
    expect((await getNotes(page, synthIdx)).length).toBe(0);
  });

  test('a NoteOn left dangling at stop still commits with a finite length', async ({ page }) => {
    // If the user stops while still holding a key, the partial note
    // should still land — its length is the time from NoteOn to stop.
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });
    await page.click(`[data-testid="track-arm-${synthIdx}"]`);

    await page.click('[data-testid="record"]');
    await fireMidi(page, 0x90, 67, 100);
    await page.waitForTimeout(80);
    // Stop without firing NoteOff — exercise the "still held when
    // recording stopped" path.
    await page.click('[data-testid="record"]');

    const notes = await getNotes(page, synthIdx);
    expect(notes.length).toBe(1);
    expect(notes[0].pitch).toBe(67);
    expect(notes[0].lengthTicks).toBeGreaterThan(0);
  });
});
