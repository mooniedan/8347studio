import { test, expect, type Page, type Locator } from '@playwright/test';

// Phase-12 M4 — interactive arrangement editing.
//
// Drag-move + right-edge resize (snapped, preview-then-commit),
// alt-drag duplicate (linked), click-select + Delete, and double-click
// drill-in to the per-track editor. Built on the M1 block CRUD.

const PX_PER_TICK = 36 / 240; // 0.15 px/tick
const BAR = 3840;
const BAR_PX = BAR * PX_PER_TICK; // 576px

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __bridge?: object }).__bridge != null);
}

/// Fresh subtractive track (one PianoRoll block at tick 0, length 1 bar)
/// then switch to arrange mode. Returns the new track index.
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
  // Exclude the `-resize` handle child, which shares the block's testid prefix.
  return page.locator(`[data-testid^="arrange-block-${trackIdx}-"]:not([data-testid$="-resize"])`);
}

async function dragBy(page: Page, target: Locator, dx: number, opts: { alt?: boolean; grabX?: number } = {}) {
  const box = (await target.boundingBox())!;
  const cx = box.x + (opts.grabX ?? Math.min(box.width / 2, 18));
  const cy = box.y + box.height / 2;
  if (opts.alt) await page.keyboard.down('Alt');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 6 });
  await page.mouse.up();
  if (opts.alt) await page.keyboard.up('Alt');
}

test.describe('phase-12 M4 — arrangement editing', () => {
  test('drag-move snaps the block to a new startTick', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    const block = blocksOn(page, idx).first();
    await expect(block).toHaveAttribute('data-start-tick', '0');

    await dragBy(page, block, BAR_PX); // one bar right
    await expect(blocksOn(page, idx).first()).toHaveAttribute('data-start-tick', String(BAR));
  });

  test('drag the right edge resizes the block length', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    const block = blocksOn(page, idx).first();
    await expect(block).toHaveAttribute('data-length-ticks', String(BAR));

    const handle = page.locator(`[data-testid^="arrange-block-${idx}-"][data-testid$="-resize"]`).first();
    await dragBy(page, handle, BAR_PX, { grabX: 3 }); // +1 bar of length
    await expect(blocksOn(page, idx).first()).toHaveAttribute('data-length-ticks', String(2 * BAR));
  });

  test('alt-drag duplicates the block (linked copy at the drop point)', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    await expect(blocksOn(page, idx)).toHaveCount(1);

    await dragBy(page, blocksOn(page, idx).first(), 2 * BAR_PX, { alt: true });
    await expect(blocksOn(page, idx)).toHaveCount(2);
    // Original stays at 0; the copy lands two bars in.
    await expect(page.locator(`[data-testid^="arrange-block-${idx}-"][data-start-tick="0"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid^="arrange-block-${idx}-"][data-start-tick="${2 * BAR}"]`)).toHaveCount(1);
  });

  test('click-select then Delete removes the block', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    await expect(blocksOn(page, idx)).toHaveCount(1);

    await blocksOn(page, idx).first().click();
    await page.keyboard.press('Delete');
    await expect(blocksOn(page, idx)).toHaveCount(0);
  });

  test('double-click a block drills into the per-track editor', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    await blocksOn(page, idx).first().dblclick();

    // Back to the per-track editor on the drilled track.
    await expect(page.getByTestId('arrangement-view')).toHaveCount(0);
    await expect(page.getByTestId('view-toggle-track')).toHaveAttribute('aria-pressed', 'true');
  });
});
