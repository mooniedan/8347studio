import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M2c — per-note velocity lane below the piano-roll.
 *
 * Each note in the clip gets a vertical bar in the lane at its
 * startTick column. Bar height encodes velocity in [30..127].
 * Pointer-drag the bar to set the velocity live; commits land on
 * the Y.Doc so collab + persistence pick them up immediately.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function notes(page: Page, trackIdx: number) {
  return page.evaluate(
    (i) => (window as any).__bridge.getPianoRollNotes(i),
    trackIdx,
  );
}

/// Drag the velocity bar for a note. Pointer-down on the bar at
/// (clientX, barTop + 4) — i.e. near its top — and pointer-up at a
/// target Y inside the lane. The lane has pointer-capture so the
/// move + up events route correctly even if the cursor leaves the
/// bar itself.
async function dragVelocity(
  page: Page,
  pitch: number,
  startTick: number,
  /// Vertical position inside the lane to land on, expressed as a
  /// ratio in [0..1] (0 = lane top → max velocity, 1 = bottom → min).
  toRatio: number,
) {
  await page.evaluate(({ p, st, ratio }) => {
    const bar = document.querySelector(
      `[data-testid="piano-vel-bar-${p}-${st}"]`,
    ) as HTMLElement;
    const lane = bar.closest('.vel-lane') as HTMLElement;
    const br = bar.getBoundingClientRect();
    const lr = lane.getBoundingClientRect();
    const targetY = lr.top + lr.height * ratio;
    const base = {
      bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1,
    };
    bar.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, clientX: br.left + br.width / 2, clientY: br.top + 4,
    }));
    lane.dispatchEvent(new PointerEvent('pointermove', {
      ...base, clientX: br.left + br.width / 2, clientY: targetY,
    }));
    lane.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: br.left + br.width / 2, clientY: targetY,
    }));
  }, { p: pitch, st: startTick, ratio: toRatio });
}

test.describe('phase-10 M2c — piano-roll velocity lane', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
  });

  test('lane renders one bar per note at the right column', async ({ page }) => {
    // Two notes on the same row at different columns.
    await page.click('[data-testid="piano-cell-60-0"]');
    await page.click('[data-testid="piano-cell-60-4"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(2);
    // Bars exist and are keyed by pitch:startTick.
    await expect(page.locator('[data-testid="piano-vel-bar-60-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="piano-vel-bar-60-960"]')).toBeVisible();
    // Default velocity = 100 — the bar advertises it for the test.
    await expect(page.locator('[data-testid="piano-vel-bar-60-0"]'))
      .toHaveAttribute('data-velocity', '100');
  });

  test('drag bar to lane top → velocity clamps near max', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    // Drag to ratio 0 (lane top) → expect VELOCITY_MAX (127).
    await dragVelocity(page, 60, 0, 0);
    await expect.poll(() => notes(page, 1).then((n) => n[0].velocity)).toBe(127);
  });

  test('drag bar to lane bottom → velocity clamps to min (30)', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    await dragVelocity(page, 60, 0, 1);
    await expect.poll(() => notes(page, 1).then((n) => n[0].velocity)).toBe(30);
  });

  test('drag bar to lane middle → velocity ~78 (midpoint of 30..127)', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    await dragVelocity(page, 60, 0, 0.5);
    // Expect midpoint = round(30 + 0.5 * 97) = 79.
    const v = await notes(page, 1).then((n) => n[0].velocity);
    expect(v).toBeGreaterThanOrEqual(76);
    expect(v).toBeLessThanOrEqual(80);
  });

  test('velocity edits do not change pitch / startTick / length', async ({ page }) => {
    // Create a 3-step note, then change its velocity.
    await page.click('[data-testid="piano-cell-60-2"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    await dragVelocity(page, 60, 2 * 240, 0);
    const ns = await notes(page, 1);
    expect(ns).toHaveLength(1);
    expect(ns[0].pitch).toBe(60);
    expect(ns[0].startTick).toBe(2 * 240);
    expect(ns[0].lengthTicks).toBe(240);
    expect(ns[0].velocity).toBe(127);
  });
});
