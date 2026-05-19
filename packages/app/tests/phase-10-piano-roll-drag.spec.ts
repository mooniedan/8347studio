import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M2a — piano-roll drag-create.
 *
 * Click-to-toggle keeps working (used by the legacy m4-piano-roll
 * specs); the new affordance is "pointer-down + drag right + up"
 * which creates a note whose lengthTicks spans the dragged columns.
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

async function dispatchDrag(
  page: Page,
  startTestId: string,
  endTestId: string,
) {
  await page.evaluate(({ start, end }) => {
    const s = document.querySelector(`[data-testid="${start}"]`) as HTMLElement;
    const e = document.querySelector(`[data-testid="${end}"]`) as HTMLElement;
    const sr = s.getBoundingClientRect();
    const er = e.getBoundingClientRect();
    const base = {
      bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
    };
    s.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height / 2,
    }));
    e.dispatchEvent(new PointerEvent('pointerenter', {
      ...base, clientX: er.left + er.width / 2, clientY: er.top + er.height / 2,
    }));
    e.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: er.left + er.width / 2, clientY: er.top + er.height / 2,
    }));
  }, { start: startTestId, end: endTestId });
}

test.describe('phase-10 M2a — piano-roll drag-create', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
  });

  test('click on an empty cell adds a 1-step note (legacy behaviour)', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    const ns = await notes(page, 1);
    expect(ns).toHaveLength(1);
    expect(ns[0].pitch).toBe(60);
    expect(ns[0].startTick).toBe(0);
    expect(ns[0].lengthTicks).toBe(240); // STEP_TICKS
  });

  test('drag across 4 cells creates a 4-step note', async ({ page }) => {
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    const ns = await notes(page, 1);
    expect(ns[0].startTick).toBe(0);
    expect(ns[0].lengthTicks).toBe(240 * 4); // 4 steps
  });

  test('drag right-to-left also creates a span (start = leftmost col)', async ({ page }) => {
    await dispatchDrag(page, 'piano-cell-60-5', 'piano-cell-60-2');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    const ns = await notes(page, 1);
    // Span normalizes — leftmost column becomes startTick.
    expect(ns[0].startTick).toBe(2 * 240);
    expect(ns[0].lengthTicks).toBe(4 * 240); // cols 2..5 inclusive
  });

  test('every column the note spans paints as "on"', async ({ page }) => {
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3');
    // All four cells must carry the .on class so the user sees a
    // continuous bar, not just the start column.
    for (const c of [0, 1, 2, 3]) {
      await expect(page.locator(`[data-testid="piano-cell-60-${c}"]`))
        .toHaveClass(/\bon\b/);
    }
    // First cell only gets the note-start accent.
    await expect(page.locator('[data-testid="piano-cell-60-0"]'))
      .toHaveClass(/note-start/);
    await expect(page.locator('[data-testid="piano-cell-60-1"]'))
      .not.toHaveClass(/note-start/);
  });

  test('clicking any column inside a multi-step note removes the whole note', async ({ page }) => {
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    // Click the middle of the note (not the start cell).
    await page.click('[data-testid="piano-cell-60-2"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(0);
  });
});
