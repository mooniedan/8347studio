import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M1 — P2 Step Sequencer polish.
 *
 * Asserts the new affordances on the Sequencer view:
 *   - Clear button wipes the visible pattern.
 *   - Randomize fills the pattern with at least a handful of hits.
 *   - Velocity lane is reachable + draggable; dragging changes the
 *     bar height (which mirrors the per-step velocity field).
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function gotoSequencer(page: Page) {
  await page.goto('/');
  await bridgeReady(page);
  // Default project ships with one StepSeq track at index 0.
  await page.click('[data-testid="track-row-0"]');
}

async function maskAt(page: Page, col: number): Promise<number> {
  return page.evaluate((c) => {
    const cells = document.querySelectorAll(`[aria-label$="step ${c + 1}"]`);
    let mask = 0;
    cells.forEach((el, idx) => {
      if (el.classList.contains('on')) mask |= 1 << idx;
    });
    return mask;
  }, col);
}

test.describe('phase-10 M1 — step-sequencer polish', () => {

  test('Clear button is present and wipes the pattern', async ({ page }) => {
    await gotoSequencer(page);

    // Paint a single hit so we have something to clear.
    await page.click('button.cell[aria-label="C3 step 1"]');
    await expect(page.locator('button.cell[aria-label="C3 step 1"]')).toHaveClass(/on/);

    await page.click('[data-testid="step-clear"]');
    await expect(page.locator('button.cell[aria-label="C3 step 1"]')).not.toHaveClass(/on/);
  });

  test('Randomize button fills the pattern with several hits', async ({ page }) => {
    await gotoSequencer(page);

    const before = await page.locator('button.cell.on').count();
    await page.click('[data-testid="step-randomize"]');
    // Randomize seeds the downbeats (every 4th step) at minimum, plus
    // a probabilistic 0–6 off-beats. The downbeats alone guarantee at
    // least 4 cells lit on the C3 row.
    await expect.poll(() => page.locator('button.cell.on').count(),
      { timeout: 3_000 },
    ).toBeGreaterThanOrEqual(4);
    // And it actually changed something.
    expect(await page.locator('button.cell.on').count()).not.toBe(before);
  });

  test('velocity lane renders one cell per step with a bar', async ({ page }) => {
    await gotoSequencer(page);
    const lane = page.getByTestId('velocity-lane-0');
    await expect(lane).toBeVisible();
    // Default velocity 100 → bar fills (100-30)/97 ≈ 72% of the cell.
    // Use the data-testid'd bar and check its height percentage.
    const heights = await page.evaluate(() => {
      const out: string[] = [];
      for (let i = 0; i < 16; i++) {
        const bar = document.querySelector(`[data-testid="velocity-bar-${i}"]`) as HTMLElement | null;
        if (bar) out.push(bar.style.height);
      }
      return out;
    });
    expect(heights.length).toBe(16);
    for (const h of heights) {
      // Percentage parseable + non-zero (default 100 is ~72%).
      const v = Number.parseFloat(h);
      expect(v).toBeGreaterThan(50);
    }
  });

  test('dragging a velocity bar changes the step velocity in the Y.Doc', async ({ page }) => {
    await gotoSequencer(page);
    // Velocity bar 0 starts at default 100. Tap near the bottom of
    // the lane — the velocityFromPointer math drops velocity toward
    // its 30 floor. Pointer events are dispatched manually so the
    // setPointerCapture-using handler sees them as a real drag.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="velocity-cell-0"]') as HTMLElement;
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom - 2,
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        buttons: 1,
      };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    });
    // Bar height should drop close to 0 (clamped at velocity 30).
    await expect.poll(async () =>
      Number.parseFloat(
        await page.locator('[data-testid="velocity-bar-0"]').evaluate(
          (el) => (el as HTMLElement).style.height,
        ),
      ),
    ).toBeLessThan(10);
  });
});
