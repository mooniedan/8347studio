import { test, expect, type Page } from '@playwright/test';

// Phase-12 M6 — whole-song transport. Entering arrange mode expands the
// loop region to span the whole arrangement so playback traverses it;
// leaving restores the user's loop.

const BAR = 3840;

interface Loop { startTick: number; endTick: number }

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __bridge?: object }).__bridge != null);
}

function loopRegion(page: Page): Promise<Loop | null> {
  return page.evaluate(() => (window as unknown as { __project: { loopRegion: Loop | null } }).__project.loopRegion);
}

test.describe('phase-12 M6 — whole-song transport', () => {
  test('arrange expands the loop to the song end; track restores it', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    const idx = await page.evaluate(() =>
      (window as unknown as { __bridge: { addSubtractiveTrack: () => number } }).__bridge.addSubtractiveTrack(),
    );
    // Place a block at bar 5 (1-bar pattern → ends at bar 6), pushing the
    // song end well past the default 4-bar loop.
    await page.evaluate((i) => {
      const b = (window as unknown as {
        __bridge: { listBlocks: (n: number) => { patternId: string }[]; placeBlock: (n: number, p: string, t: number) => string };
      }).__bridge;
      b.placeBlock(i, b.listBlocks(i)[0].patternId, 5 * 3840);
    }, idx);

    const before = await loopRegion(page);

    await page.getByTestId('view-toggle-arrange').click();
    await expect(page.getByTestId('arrangement-view')).toBeVisible();
    const arranged = await loopRegion(page);
    expect(arranged).toEqual({ startTick: 0, endTick: 6 * BAR });

    await page.getByTestId('view-toggle-track').click();
    const restored = await loopRegion(page);
    expect(restored).toEqual(before);
  });
});
