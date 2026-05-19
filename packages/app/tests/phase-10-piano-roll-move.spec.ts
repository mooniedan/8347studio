import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M2b — piano-roll drag-move + drag-resize.
 *
 * Existing notes can be dragged by their interior (move mode) or
 * stretched by their right-edge grip (resize mode). Click-to-remove
 * still works (M2a contract).
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

interface DragOpts {
  /// Fraction of cell-width to land the pointer at (0..1). Defaults
  /// to 0.5 — pointer in the middle. Use 0.9 to land in the resize
  /// grip zone on the last cell of a note.
  xRatio?: number;
}

async function dispatchDrag(
  page: Page,
  startTestId: string,
  endTestId: string,
  opts: DragOpts = {},
) {
  const { xRatio = 0.5 } = opts;
  await page.evaluate(({ start, end, xr }) => {
    const s = document.querySelector(`[data-testid="${start}"]`) as HTMLElement;
    const e = document.querySelector(`[data-testid="${end}"]`) as HTMLElement;
    const sr = s.getBoundingClientRect();
    const er = e.getBoundingClientRect();
    const base = {
      bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
    };
    s.dispatchEvent(new PointerEvent('pointerdown', {
      ...base,
      clientX: sr.left + sr.width * xr,
      clientY: sr.top + sr.height / 2,
    }));
    if (start !== end) {
      e.dispatchEvent(new PointerEvent('pointerenter', {
        ...base,
        clientX: er.left + er.width / 2,
        clientY: er.top + er.height / 2,
      }));
    }
    e.dispatchEvent(new PointerEvent('pointerup', {
      ...base,
      clientX: er.left + er.width / 2,
      clientY: er.top + er.height / 2,
    }));
  }, { start: startTestId, end: endTestId, xr: xRatio });
}

test.describe('phase-10 M2b — piano-roll drag-move + drag-resize', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
  });

  test('drag-move shifts a note to a new column on the same row', async ({ page }) => {
    // Seed a 1-step note at col 0, then drag its interior to col 4.
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-4');
    const ns = await notes(page, 1);
    expect(ns).toHaveLength(1);
    expect(ns[0].pitch).toBe(60);
    expect(ns[0].startTick).toBe(4 * 240);
    expect(ns[0].lengthTicks).toBe(240);
  });

  test('drag-move shifts a note to a different pitch row', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-2"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    // Move up by 3 semitones, right by 1 col.
    await dispatchDrag(page, 'piano-cell-60-2', 'piano-cell-63-3');
    const ns = await notes(page, 1);
    expect(ns).toHaveLength(1);
    expect(ns[0].pitch).toBe(63);
    expect(ns[0].startTick).toBe(3 * 240);
  });

  test('drag-move preserves the note length when shifting', async ({ page }) => {
    // Create a 4-step note, then move it.
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    // Grab the interior (col 1) and drop on col 5 — note slides by +4.
    await dispatchDrag(page, 'piano-cell-60-1', 'piano-cell-60-5');
    const ns = await notes(page, 1);
    expect(ns).toHaveLength(1);
    expect(ns[0].startTick).toBe(4 * 240); // shifted by +4 cols
    expect(ns[0].lengthTicks).toBe(4 * 240); // length preserved
  });

  test('drag-resize on the right-edge grip extends the note', async ({ page }) => {
    // 1-step note at col 0; grab its right grip and extend to col 3.
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3', { xRatio: 0.9 });
    const ns = await notes(page, 1);
    expect(ns).toHaveLength(1);
    expect(ns[0].startTick).toBe(0);
    expect(ns[0].lengthTicks).toBe(4 * 240); // cols 0..3 inclusive
  });

  test('drag-resize can shrink a multi-step note', async ({ page }) => {
    // Make a 4-step note, then resize from its right grip back to col 1.
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    // Grip is the last cell (col 3) at xRatio 0.9; drag to col 1.
    await dispatchDrag(page, 'piano-cell-60-3', 'piano-cell-60-1', { xRatio: 0.9 });
    const ns = await notes(page, 1);
    expect(ns).toHaveLength(1);
    expect(ns[0].startTick).toBe(0);
    expect(ns[0].lengthTicks).toBe(2 * 240); // cols 0..1
  });

  test('click on existing note (no drag) still removes it', async ({ page }) => {
    // M2a contract preserved: tap-on-note → delete.
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    // Click the middle cell (no drag delta).
    await page.click('[data-testid="piano-cell-60-2"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(0);
  });
});
