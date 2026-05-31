import { test, expect, type Page } from '@playwright/test';

// Phase-12 M2a — multi-block piano-roll flatten + loop-to-fill.
//
// The keystone: blocks become audible. A PianoRoll pattern placed as
// multiple blocks (or as one loop-to-fill block) must reach the engine
// as absolute-tick notes at the right song positions. These specs
// assert the flattened scheduler-note list directly (the exact input
// the ClipScheduler consumes) — deterministic, unlike parsing rendered
// PCM. Step-seq (oscillator) tracks are M2b; here we use subtractive
// tracks, whose PianoRoll patterns already flow through the scheduler.

// Project tick grid: PPQ = 960 → 1 bar (4/4) = 4 * 960 = 3840 ticks.
// These are model constants, not environment values.
const BAR = 3840;

interface Note { pitch: number; velocity: number; startTick: number; lengthTicks: number }
interface BlockView { id: string; patternId: string; kind: string; startTick: number; lengthTicks: number; loop: boolean }

interface ArrangeBridge {
  addSubtractiveTrack: () => number;
  listBlocks: (trackIdx: number) => BlockView[];
  placeBlock: (trackIdx: number, patternId: string, startTick: number, opts?: { lengthTicks?: number; loop?: boolean }) => string;
  resizeBlock: (blockId: string, len: number) => boolean;
  deleteBlock: (blockId: string) => boolean;
  addNoteToPattern: (patternId: string, note: Note) => boolean;
  inspectScheduledNotes: (trackIdx: number) => Note[];
  getPianoRollNotes: (trackIdx: number) => Note[];
}

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __bridge?: object }).__bridge != null);
}

/// A fresh subtractive track with an empty PianoRoll pattern + its
/// migrated block. Returns { idx, patternId, blockId }.
async function freshSubtractive(page: Page) {
  return page.evaluate(() => {
    const b = (window as unknown as { __bridge: ArrangeBridge }).__bridge;
    const idx = b.addSubtractiveTrack();
    const block = b.listBlocks(idx)[0];
    return { idx, patternId: block.patternId, blockId: block.id };
  }) as Promise<{ idx: number; patternId: string; blockId: string }>;
}

function ticksOf(notes: Note[]): number[] {
  return notes.map((n) => n.startTick).sort((a, b) => a - b);
}

test.describe('phase-12 M2a — multi-block flatten', () => {
  test('two blocks of one pattern emit notes at both song positions', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const { idx, patternId } = await freshSubtractive(page);

    // One note at the top of the pattern.
    await page.evaluate(
      (a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.addNoteToPattern(a.patternId, {
        pitch: 60, velocity: 100, startTick: 0, lengthTicks: 240,
      }),
      { patternId },
    );

    // Migrated block A sits at 0 → one scheduled note at tick 0.
    let notes = await page.evaluate((i) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(i), idx);
    expect(ticksOf(notes)).toEqual([0]);

    // Place a second, linked block two bars in.
    await page.evaluate(
      (a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.placeBlock(a.idx, a.patternId, a.at),
      { idx, patternId, at: 2 * BAR },
    );
    notes = await page.evaluate((i) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(i), idx);
    // Both placements fire — bar 0 and bar 2.
    expect(ticksOf(notes)).toEqual([0, 2 * BAR]);
  });

  test('loop-to-fill: a 1-bar pattern in a 4-bar block fires 4×', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const { idx, patternId, blockId } = await freshSubtractive(page);

    await page.evaluate(
      (a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.addNoteToPattern(a.patternId, {
        pitch: 60, velocity: 100, startTick: 0, lengthTicks: 240,
      }),
      { patternId },
    );
    // Grow the block to 4 bars; pattern is 1 bar → loop fills it 4×.
    await page.evaluate(
      (a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.resizeBlock(a.blockId, a.len),
      { blockId, len: 4 * BAR },
    );

    const notes = await page.evaluate((i) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(i), idx);
    expect(ticksOf(notes)).toEqual([0, BAR, 2 * BAR, 3 * BAR]);
  });

  test('non-loop block plays its pattern exactly once', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const { idx, patternId, blockId } = await freshSubtractive(page);

    await page.evaluate(
      (a) => {
        const b = (window as unknown as { __bridge: ArrangeBridge }).__bridge;
        b.addNoteToPattern(a.patternId, { pitch: 60, velocity: 100, startTick: 0, lengthTicks: 240 });
        b.deleteBlock(a.blockId); // drop the default loop block
        b.placeBlock(a.idx, a.patternId, 0, { lengthTicks: a.len, loop: false });
      },
      { idx, patternId, blockId, len: 4 * BAR },
    );

    const notes = await page.evaluate((i) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(i), idx);
    expect(ticksOf(notes)).toEqual([0]); // once, not four times
  });

  test('demo lead is unchanged: single full-width block flattens to identity', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __project: { projectName: string | null } }).__project.projectName))
      .toBe('Demo Song');

    // Lead (track 0) has one PianoRoll block at 0 → flattened notes
    // match the authored notes one-for-one (no drift, no duplication).
    const authored = await page.evaluate(() => (window as unknown as { __bridge: ArrangeBridge }).__bridge.getPianoRollNotes(0));
    const scheduled = await page.evaluate(() => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(0));
    expect(scheduled.length).toBe(authored.length);
    expect(ticksOf(scheduled)).toEqual(ticksOf(authored));
  });
});
