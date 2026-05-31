import { test, expect, type Page, type Locator } from '@playwright/test';

// Phase-12 M5a — empty-lane create + active-pattern drill-in.
//
// Double-clicking empty MIDI-lane space creates a new pattern + block.
// Drilling into a block opens *that block's* pattern in the per-track
// editor (the clipId plumbing), so a track with several patterns edits
// the right one.

const BAR = 3840;

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __bridge?: object }).__bridge != null);
}

async function arrangeWithSubtractive(page: Page): Promise<number> {
  await page.goto('/');
  await bridgeReady(page);
  const idx = await page.evaluate(() =>
    (window as unknown as { __bridge: { addSubtractiveTrack: () => number } }).__bridge.addSubtractiveTrack(),
  );
  await page.getByTestId('view-toggle-arrange').click();
  await expect(page.getByTestId('arrangement-view')).toBeVisible();
  return idx;
}

function blocksOn(page: Page, trackIdx: number): Locator {
  return page.locator(`[data-testid^="arrange-block-${trackIdx}-"]:not([data-testid$="-resize"])`);
}

test.describe('phase-12 M5a — create + active-pattern drill-in', () => {
  test('double-click an empty MIDI lane creates a new block', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    await expect(blocksOn(page, idx)).toHaveCount(1);

    // Double-click well past the at-0 block (1 bar wide) → new block.
    await page.getByTestId(`arrange-lane-body-${idx}`).dblclick({ position: { x: 1000, y: 18 } });
    await expect(blocksOn(page, idx)).toHaveCount(2);
  });

  test('drilling into a block opens that block’s pattern (not the first)', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);

    // Pattern A (the migrated block) gets one note.
    await page.evaluate((i) => {
      const b = (window as unknown as {
        __bridge: { listBlocks: (n: number) => { patternId: string }[]; addNoteToPattern: (p: string, n: object) => boolean };
      }).__bridge;
      const a = b.listBlocks(i)[0].patternId;
      b.addNoteToPattern(a, { pitch: 60, velocity: 100, startTick: 0, lengthTicks: 240 });
    }, idx);

    // Create pattern B via empty-lane double-click (stays in arrange).
    await page.getByTestId(`arrange-lane-body-${idx}`).dblclick({ position: { x: 1000, y: 18 } });
    await expect(blocksOn(page, idx)).toHaveCount(2);

    // Drill into pattern B (the new, empty one — it snapped to a bar).
    const bBlock = page.locator(`[data-testid^="arrange-block-${idx}-"][data-start-tick="${2 * BAR}"]:not([data-testid$="-resize"])`);
    await bBlock.dblclick();
    // Editor opened on the empty pattern → no velocity bars (no notes).
    await expect(page.locator('[data-testid^="piano-vel-bar-"]')).toHaveCount(0);

    // Back to arrange, drill into pattern A → its single note shows.
    await page.getByTestId('view-toggle-arrange').click();
    await page.locator(`[data-testid^="arrange-block-${idx}-"][data-start-tick="0"]:not([data-testid$="-resize"])`).dblclick();
    await expect(page.locator('[data-testid^="piano-vel-bar-"]')).toHaveCount(1);
  });
});
