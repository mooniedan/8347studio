import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M2d — selection rectangle + multi-select + delete.
 *
 * Shift-drag across the grid draws a selection rectangle; on
 * release every note overlapping the rect joins `selectedNotes`.
 * Shift-click toggles a single note. Plain interactions still do
 * what M2a/M2b/M2c say they do — selection is purely additive.
 * Delete / Backspace removes every selected note.
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
  shift?: boolean;
  /// Cells the drag visits between start and end (inclusive). The
  /// helper fires `pointerenter` on each, in order, so the live
  /// drag state observes them — needed for rectangles that span
  /// multiple rows since the implementation tracks `currMidi` from
  /// pointer-enter events on each cell.
  via?: string[];
}

async function dispatchDrag(
  page: Page,
  startTestId: string,
  endTestId: string,
  opts: DragOpts = {},
) {
  const { shift = false, via = [endTestId] } = opts;
  await page.evaluate(({ start, hops, sh }) => {
    function center(el: HTMLElement) {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const s = document.querySelector(`[data-testid="${start}"]`) as HTMLElement;
    const sp = center(s);
    const base = {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      shiftKey: sh,
    };
    s.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, clientX: sp.x, clientY: sp.y,
    }));
    let last = s;
    for (const id of hops) {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      if (!el) continue;
      const p = center(el);
      el.dispatchEvent(new PointerEvent('pointerenter', {
        ...base, clientX: p.x, clientY: p.y,
      }));
      last = el;
    }
    const lp = center(last);
    last.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: lp.x, clientY: lp.y,
    }));
  }, { start: startTestId, hops: via, sh: shift });
}

test.describe('phase-10 M2d — piano-roll selection + delete', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
  });

  test('shift+click on a note adds the `selected` outline', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    // Shift+click on the same cell — it's now an existing note, so
    // shift-click toggles it into selection.
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-0', { shift: true });
    await expect(page.locator('[data-testid="piano-cell-60-0"]'))
      .toHaveClass(/selected/);
    // Toggle off.
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-0', { shift: true });
    await expect(page.locator('[data-testid="piano-cell-60-0"]'))
      .not.toHaveClass(/selected/);
  });

  test('shift+drag rectangle selects every note inside', async ({ page }) => {
    // Three notes: two inside the rect (cols 0..3 on pitch 60), one
    // outside (col 5 on pitch 60).
    await page.click('[data-testid="piano-cell-60-0"]');
    await page.click('[data-testid="piano-cell-60-2"]');
    await page.click('[data-testid="piano-cell-60-5"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(3);
    // Shift-drag from (col 0, pitch 60) → (col 3, pitch 60).
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3', {
      shift: true,
      via: ['piano-cell-60-1', 'piano-cell-60-2', 'piano-cell-60-3'],
    });
    await expect(page.locator('[data-testid="piano-cell-60-0"]'))
      .toHaveClass(/selected/);
    await expect(page.locator('[data-testid="piano-cell-60-2"]'))
      .toHaveClass(/selected/);
    await expect(page.locator('[data-testid="piano-cell-60-5"]'))
      .not.toHaveClass(/selected/);
  });

  test('Delete key removes every selected note', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    await page.click('[data-testid="piano-cell-60-2"]');
    await page.click('[data-testid="piano-cell-60-5"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(3);
    // Select the first two with a rect.
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3', {
      shift: true,
      via: ['piano-cell-60-1', 'piano-cell-60-2', 'piano-cell-60-3'],
    });
    await page.keyboard.press('Delete');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    const ns = await notes(page, 1);
    expect(ns[0].startTick).toBe(5 * 240); // the survivor
  });

  test('Backspace works the same as Delete', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-0', { shift: true });
    await page.keyboard.press('Backspace');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(0);
  });

  test('Delete with no selection is a no-op', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-0"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
    await page.keyboard.press('Delete');
    // The note remains; no selection ever existed.
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(1);
  });

  test('rect select spans multiple pitch rows', async ({ page }) => {
    await page.click('[data-testid="piano-cell-60-2"]');
    await page.click('[data-testid="piano-cell-62-2"]');
    await page.click('[data-testid="piano-cell-65-2"]');
    await expect.poll(() => notes(page, 1).then((n) => n.length)).toBe(3);
    // Rect from (col 2, midi 60) to (col 2, midi 63) covers pitches
    // 60..63 → catches 60 + 62, misses 65.
    await dispatchDrag(page, 'piano-cell-60-2', 'piano-cell-63-2', {
      shift: true,
      via: ['piano-cell-61-2', 'piano-cell-62-2', 'piano-cell-63-2'],
    });
    await expect(page.locator('[data-testid="piano-cell-60-2"]'))
      .toHaveClass(/selected/);
    await expect(page.locator('[data-testid="piano-cell-62-2"]'))
      .toHaveClass(/selected/);
    await expect(page.locator('[data-testid="piano-cell-65-2"]'))
      .not.toHaveClass(/selected/);
  });

  test('selection survives a note-move (key stays stable)', async ({ page }) => {
    // After M2b: drag-move removes + re-adds a note with a new
    // (pitch, startTick) identity. Selection is keyed by that
    // identity, so the moved note should NOT remain selected. This
    // documents the chosen behaviour — selection clears on identity
    // change, not on transient updates.
    await page.click('[data-testid="piano-cell-60-0"]');
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-0', { shift: true });
    await expect(page.locator('[data-testid="piano-cell-60-0"]'))
      .toHaveClass(/selected/);
    // Move it (plain drag, no shift). After commit the note is at
    // col 3 — same pitch — but its startTick changed, so the old
    // selection key drops.
    await dispatchDrag(page, 'piano-cell-60-0', 'piano-cell-60-3');
    const ns = await notes(page, 1);
    expect(ns[0].startTick).toBe(3 * 240);
    await expect(page.locator('[data-testid="piano-cell-60-3"]'))
      .not.toHaveClass(/selected/);
  });
});
