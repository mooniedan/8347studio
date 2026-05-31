import { test, expect, type Page } from '@playwright/test';

// Phase-12 M3 — read-only arrangement view.
//
// The all-tracks timeline: a track↔arrange toggle swaps the canvas to
// stacked lanes with blocks positioned by startTick, a bar ruler, and a
// playhead. M3 is read-only — selecting a lane is the only interaction.

const PX_PER_TICK = 36 / 240; // 36px per 1/16 step (STEP_TICKS = 240)
const BAR = 3840;

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __bridge?: object }).__bridge != null);
}

async function seedDemo(page: Page) {
  await page.goto('/');
  await bridgeReady(page);
  await page.click('[data-testid="projects-menu"]');
  await page.click('[data-testid="projects-new-demo"]');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __project: { projectName: string | null } }).__project.projectName))
    .toBe('Demo Song');
}

test.describe('phase-12 M3 — arrangement view', () => {
  test('toggle swaps the canvas to the arrangement timeline with lanes per track', async ({ page }) => {
    await seedDemo(page);

    // Default is the per-track editor; arrangement view is absent.
    await expect(page.getByTestId('arrangement-view')).toHaveCount(0);

    await page.getByTestId('view-toggle-arrange').click();
    await expect(page.getByTestId('arrangement-view')).toBeVisible();
    await expect(page.getByTestId('arrange-ruler')).toBeVisible();

    // One lane per track.
    const trackCount = await page.evaluate(
      () => (window as unknown as { __project: { trackCount: number } }).__project.trackCount,
    );
    for (let i = 0; i < trackCount; i++) {
      await expect(page.getByTestId(`arrange-lane-${i}`)).toBeVisible();
    }

    // Toggle back restores the per-track editor.
    await page.getByTestId('view-toggle-track').click();
    await expect(page.getByTestId('arrangement-view')).toHaveCount(0);
  });

  test('blocks render at their startTick (pixel position matches the tick grid)', async ({ page }) => {
    await seedDemo(page);
    await page.getByTestId('view-toggle-arrange').click();
    await expect(page.getByTestId('arrangement-view')).toBeVisible();

    // The lead (track 0) has at least one block at tick 0.
    const leadBlocks = page.locator('[data-testid^="arrange-block-0-"]');
    expect(await leadBlocks.count()).toBeGreaterThanOrEqual(1);
    const first = leadBlocks.first();
    expect(await first.getAttribute('data-start-tick')).toBe('0');
    // Inline left maps tick→px via PX_PER_TICK.
    await expect(first).toHaveAttribute('style', /left:\s*0px/);

    // Place a second block two bars in on track 0's pattern and confirm
    // it lands at the right pixel offset.
    await page.evaluate((at) => {
      const w = window as unknown as {
        __bridge: { listBlocks: (i: number) => { patternId: string }[]; placeBlock: (i: number, p: string, t: number) => string };
      };
      const pid = w.__bridge.listBlocks(0)[0].patternId;
      w.__bridge.placeBlock(0, pid, at);
    }, 2 * BAR);

    const offset = page.locator(`[data-testid^="arrange-block-0-"][data-start-tick="${2 * BAR}"]`);
    await expect(offset).toBeVisible();
    const expectedLeft = Math.round(2 * BAR * PX_PER_TICK); // 1152px
    await expect(offset).toHaveAttribute('style', new RegExp(`left:\\s*${expectedLeft}px`));
  });

  test('clicking a lane header selects that track (read-only interaction)', async ({ page }) => {
    await seedDemo(page);
    await page.getByTestId('view-toggle-arrange').click();

    await page.getByTestId('arrange-lane-head-2').click();
    await expect(page.getByTestId('arrange-lane-2')).toHaveClass(/selected/);
    // Switching back to the track editor shows the now-selected track.
    await page.getByTestId('view-toggle-track').click();
    await expect(page.getByTestId('canvas-track-name')).toBeVisible();
  });

  test('playhead is present in the arrangement', async ({ page }) => {
    await seedDemo(page);
    await page.getByTestId('view-toggle-arrange').click();
    await expect(page.getByTestId('arrange-playhead')).toBeVisible();
  });
});
