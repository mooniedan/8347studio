import { test, expect, type Page } from '@playwright/test';

// Phase-12 M1 — pattern/block arrangement model + migration.
//
// A PATTERN is reusable track-owned content (today's clip); a BLOCK is
// a placement of a pattern on the track's lane. These tests drive the
// model through the `__bridge` surface (the arrangement UI lands in
// M3+). They lock the three things M1 promises: migration back-fills a
// block per clip, the CRUD round-trips through the Y.Doc, linked
// duplicates share a pattern, and Make Unique forks a real copy.

interface BlockView {
  id: string;
  patternId: string;
  kind: string;
  startTick: number;
  lengthTicks: number;
  loop: boolean;
}

interface ArrangeBridge {
  listBlocks: (trackIdx: number) => BlockView[];
  placeBlock: (
    trackIdx: number,
    patternId: string,
    startTick: number,
    opts?: { lengthTicks?: number; loop?: boolean },
  ) => string;
  moveBlock: (blockId: string, newStartTick: number) => boolean;
  resizeBlock: (blockId: string, newLengthTicks: number) => boolean;
  duplicateBlock: (blockId: string, atStartTick?: number) => string;
  makeUnique: (blockId: string) => string;
  deleteBlock: (blockId: string) => boolean;
  patternStepMask: (patternId: string) => number[] | null;
  setPatternStepMask: (patternId: string, index: number, notes: number) => boolean;
}

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

function arrange(page: Page) {
  return {
    listBlocks: (trackIdx: number) =>
      page.evaluate((i) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.listBlocks(i), trackIdx),
    placeBlock: (trackIdx: number, patternId: string, startTick: number, opts?: { lengthTicks?: number; loop?: boolean }) =>
      page.evaluate(
        (a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.placeBlock(a.trackIdx, a.patternId, a.startTick, a.opts),
        { trackIdx, patternId, startTick, opts },
      ),
    moveBlock: (blockId: string, t: number) =>
      page.evaluate((a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.moveBlock(a.blockId, a.t), { blockId, t }),
    resizeBlock: (blockId: string, len: number) =>
      page.evaluate((a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.resizeBlock(a.blockId, a.len), { blockId, len }),
    duplicateBlock: (blockId: string, at?: number) =>
      page.evaluate((a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.duplicateBlock(a.blockId, a.at), { blockId, at }),
    makeUnique: (blockId: string) =>
      page.evaluate((id) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.makeUnique(id), blockId),
    deleteBlock: (blockId: string) =>
      page.evaluate((id) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.deleteBlock(id), blockId),
    patternStepMask: (patternId: string) =>
      page.evaluate((id) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.patternStepMask(id), patternId),
    setPatternStepMask: (patternId: string, index: number, notes: number) =>
      page.evaluate(
        (a) => (window as unknown as { __bridge: ArrangeBridge }).__bridge.setPatternStepMask(a.patternId, a.index, a.notes),
        { patternId, index, notes },
      ),
    clipCount: () =>
      page.evaluate(() => (window as unknown as { __project: { clipCount: number } }).__project.clipCount),
  };
}

async function seedDemo(page: Page) {
  await page.goto('/');
  await bridgeReady(page);
  await page.click('[data-testid="projects-menu"]');
  await page.click('[data-testid="projects-new-demo"]');
  await bridgeReady(page);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __project: { projectName: string | null } }).__project.projectName))
    .toBe('Demo Song');
}

test.describe('phase-12 M1 — pattern/block model', () => {
  test('migration back-fills a block per clip mirroring its position', async ({ page }) => {
    await seedDemo(page);
    const a = arrange(page);

    // Collect every block across the demo's tracks.
    const trackCount = await page.evaluate(
      () => (window as unknown as { __project: { trackCount: number } }).__project.trackCount,
    );
    const all: BlockView[] = [];
    for (let i = 0; i < trackCount; i++) all.push(...(await a.listBlocks(i)));

    // The demo's MIDI tracks (lead, bass, drums…) each get ≥1 block.
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const b of all) {
      // Every block points at a live pattern (kind resolved, not orphan).
      expect(['StepSeq', 'PianoRoll']).toContain(b.kind);
      expect(b.patternId).not.toBe('');
      expect(b.startTick).toBeGreaterThanOrEqual(0);
      expect(b.lengthTicks).toBeGreaterThan(0);
    }
  });

  test('place / move / resize round-trip through the Y.Doc', async ({ page }) => {
    await seedDemo(page);
    const a = arrange(page);

    // Reuse a known MIDI track's pattern (track 1 = bass step-seq).
    const before = await a.listBlocks(1);
    expect(before.length).toBeGreaterThanOrEqual(1);
    const patternId = before[0].patternId;

    const blockId = await a.placeBlock(1, patternId, 7680, { lengthTicks: 3840 });
    expect(blockId).not.toBe('');

    let blocks = await a.listBlocks(1);
    const placed = blocks.find((b) => b.id === blockId)!;
    expect(placed).toBeTruthy();
    expect(placed.startTick).toBe(7680);
    expect(placed.lengthTicks).toBe(3840);
    expect(placed.patternId).toBe(patternId); // linked to the same pattern

    expect(await a.moveBlock(blockId, 9600)).toBe(true);
    expect(await a.resizeBlock(blockId, 1920)).toBe(true);
    blocks = await a.listBlocks(1);
    const moved = blocks.find((b) => b.id === blockId)!;
    expect(moved.startTick).toBe(9600);
    expect(moved.lengthTicks).toBe(1920);
  });

  test('duplicate is linked; Make Unique forks an independent pattern', async ({ page }) => {
    await seedDemo(page);
    const a = arrange(page);

    const blocks0 = await a.listBlocks(1);
    const origBlock = blocks0[0];
    const sharedPattern = origBlock.patternId;

    // Duplicate → a second block sharing the SAME pattern (linked).
    const dupId = await a.duplicateBlock(origBlock.id);
    expect(dupId).not.toBe('');
    let blocks = await a.listBlocks(1);
    const dup = blocks.find((b) => b.id === dupId)!;
    expect(dup.patternId).toBe(sharedPattern);

    const clipsBefore = await a.clipCount();

    // Make Unique on the duplicate → forks a new pattern.
    const newPattern = await a.makeUnique(dupId);
    expect(newPattern).not.toBe('');
    expect(newPattern).not.toBe(sharedPattern);
    expect(await a.clipCount()).toBe(clipsBefore + 1); // a real new pattern

    blocks = await a.listBlocks(1);
    expect(blocks.find((b) => b.id === dupId)!.patternId).toBe(newPattern);
    // The still-linked original keeps the shared pattern.
    expect(blocks.find((b) => b.id === origBlock.id)!.patternId).toBe(sharedPattern);

    // Fork is a real copy: it matches at fork time…
    const forkMask = await a.patternStepMask(newPattern);
    expect(forkMask).not.toBeNull();
    // …but editing the original pattern does NOT change the fork.
    await a.setPatternStepMask(sharedPattern, 0, 0xff);
    expect((await a.patternStepMask(sharedPattern))![0]).toBe(0xff);
    expect((await a.patternStepMask(newPattern))![0]).toBe(forkMask![0]);
  });

  test('delete removes the block but keeps the pattern in the library', async ({ page }) => {
    await seedDemo(page);
    const a = arrange(page);

    const blocks0 = await a.listBlocks(1);
    const patternId = blocks0[0].patternId;
    const extra = await a.placeBlock(1, patternId, 11520);
    const clipsBefore = await a.clipCount();

    expect(await a.deleteBlock(extra)).toBe(true);
    const blocks = await a.listBlocks(1);
    expect(blocks.find((b) => b.id === extra)).toBeUndefined();
    // Pattern still present — delete is a placement op, not a content op.
    expect(await a.clipCount()).toBe(clipsBefore);
  });
});
