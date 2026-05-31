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
  setPatternStepMask: (patternId: string, index: number, notes: number) => boolean;
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

// SEQ_LOW_MIDI from the engine: step bit 0 = MIDI note 48.
const SEQ_LOW_MIDI = 48;

/// The default project's first track is a step-seq oscillator track.
/// Returns its single migrated block + pattern; sets step 0's bit 0 so
/// the pattern has exactly one note (pitch 48 at tick 0).
async function stepTrackWithOneHit(page: Page) {
  return page.evaluate(() => {
    const b = (window as unknown as { __bridge: ArrangeBridge }).__bridge;
    const block = b.listBlocks(0)[0];
    b.setPatternStepMask(block.patternId, 0, 1); // step 0, bit 0 → MIDI 48 @ tick 0
    return { idx: 0, patternId: block.patternId, blockId: block.id, kind: block.kind };
  }) as Promise<{ idx: number; patternId: string; blockId: string; kind: string }>;
}

test.describe('phase-12 M2b — step-block flatten', () => {
  test('single step block at 0 stays self-clocked (no scheduled notes)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const t = await stepTrackWithOneHit(page);
    expect(t.kind).toBe('StepSeq'); // precondition: default track 0 is step-seq

    // One block at tick 0 → the sequencer self-clocks it; nothing is
    // routed through the ClipScheduler (so it isn't double-fired).
    const notes = await page.evaluate(() => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(0));
    expect(notes).toEqual([]);
  });

  test('a second step block makes the track note-driven at both positions', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const t = await stepTrackWithOneHit(page);

    await page.evaluate(
      (a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.placeBlock(a.idx, a.patternId, a.at),
      { idx: t.idx, patternId: t.patternId, at: 2 * BAR },
    );
    const notes = await page.evaluate(() => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(0));
    // Both blocks now flatten to notes at MIDI 48, bars 0 and 2.
    expect(ticksOf(notes)).toEqual([0, 2 * BAR]);
    expect(notes.every((n) => n.pitch === SEQ_LOW_MIDI)).toBe(true);
  });

  test('offset step block loops its pattern to fill (2× in a 2-bar block)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const t = await stepTrackWithOneHit(page);

    // Drop the at-0 block and place a single 2-bar block two bars in.
    // A single offset block is an arrangement → note-driven; the 1-bar
    // pattern loops twice to fill it (bars 2 and 3).
    await page.evaluate(
      (a) => {
        const b = (window as unknown as { __bridge: ArrangeBridge }).__bridge;
        b.deleteBlock(a.blockId);
        b.placeBlock(a.idx, a.patternId, a.at, { lengthTicks: a.len, loop: true });
      },
      { idx: t.idx, patternId: t.patternId, blockId: t.blockId, at: 2 * BAR, len: 2 * BAR },
    );
    const notes = await page.evaluate(() => (window as unknown as { __bridge: ArrangeBridge }).__bridge.inspectScheduledNotes(0));
    expect(ticksOf(notes)).toEqual([2 * BAR, 3 * BAR]);
  });
});
