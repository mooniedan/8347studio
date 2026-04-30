import { test, expect, type Page } from '@playwright/test';

// M5 verifies the multi-track content model:
//   1. Adding a track creates a new entry in the TrackList and
//      a fresh step grid (linked to a new MIDI track + StepSeq clip
//      in the Y.Doc).
//   2. Each track owns its own clip — toggling a step on one track
//      does not flip cells on another.
//   3. The engine sees the new track on its next snapshot rebuild
//      (debugTrackCount jumps to 2).

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function debugTrackCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const w = window as unknown as { __bridge: { debugTrackCount: () => Promise<number> } };
    return w.__bridge.debugTrackCount();
  });
}

test.describe('phase-1 / M5 multi-track', () => {
  test('add track adds a row, a fresh grid, and shows up in the engine', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // One track to start with.
    await expect(page.locator('[data-testid="track-row-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="track-row-1"]')).toHaveCount(0);
    await expect.poll(() => debugTrackCount(page)).toBe(1);

    // Add a second track.
    await page.click('[data-testid="add-track"]');
    await expect(page.locator('[data-testid="track-row-1"]')).toBeVisible();

    // After adding, the new track is selected and its grid is shown.
    await expect(page.locator('[data-testid="grid-1"]')).toBeVisible();

    // Second track is empty — no cells lit on the visible grid.
    await expect(page.locator('[data-testid="grid-1"] .cell.on')).toHaveCount(0);

    // Engine sees two tracks.
    await expect.poll(() => debugTrackCount(page), { timeout: 2000 }).toBe(2);
  });

  test('per-track step toggles are independent', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Toggle one cell on track 0.
    await page.locator('[data-testid="grid-0"] .cell').nth(0).click();
    await expect(page.locator('[data-testid="grid-0"] .cell.on')).toHaveCount(1);

    // Add and switch to track 1.
    await page.click('[data-testid="add-track"]');
    await expect(page.locator('[data-testid="grid-1"]')).toBeVisible();

    // Track 1 starts empty — no cells lit.
    await expect(page.locator('[data-testid="grid-1"] .cell.on')).toHaveCount(0);

    // Toggle two cells on track 1.
    await page.locator('[data-testid="grid-1"] .cell').nth(5).click();
    await page.locator('[data-testid="grid-1"] .cell').nth(20).click();
    await expect(page.locator('[data-testid="grid-1"] .cell.on')).toHaveCount(2);

    // Switch back to track 0; it still has its single cell, not track-1's two.
    await page.click('[data-testid="track-row-0"]');
    await expect(page.locator('[data-testid="grid-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="grid-0"] .cell.on')).toHaveCount(1);
  });
});
