import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M4 — automation lane visuals.
 *
 * Pre-Phase 10 the only way to add automation points was the
 * `__bridge.addAutomationPoint` backdoor. This phase surfaces the
 * lane as an SVG mini-editor below the track editor:
 *   - Each lane on the active track renders as one row.
 *   - A polyline connects existing points; circles mark them.
 *   - Click empty area → add a point.
 *   - Drag a point → move it (commit on release as remove + add).
 *   - Shift-click a point → delete.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function loadDemoWithFilterLane(page: Page) {
  await page.goto('/');
  await bridgeReady(page);
  await page.click('[data-testid="projects-menu"]');
  await page.click('[data-testid="projects-new-demo"]');
  await bridgeReady(page);
  await page.click('[data-testid="track-row-0"]'); // Lead synth
  // Demo seeds the automation lane in the background — wait for it.
  await page.waitForFunction(() => {
    const lanes = (window as any).__bridge.listAutomationLanes();
    return lanes.some((l: any) => l.trackIdx === 0 && l.points.length >= 3);
  });
}

async function lanePoints(page: Page) {
  return page.evaluate(() => {
    const lanes = (window as any).__bridge.listAutomationLanes();
    const lane = lanes.find((l: any) => l.target === 'instrument');
    return lane?.points ?? [];
  });
}

test.describe('phase-10 M4 — automation lane visuals', () => {

  test('demo lead track exposes its filter-cutoff lane as an SVG row', async ({ page }) => {
    await loadDemoWithFilterLane(page);
    const lanes = page.locator('[data-testid^="automation-lane-0-"]');
    await expect(lanes.first()).toBeVisible({ timeout: 5_000 });
    // The demo seeds 3 points on instrument:0:6 (SUB_FILTER_CUTOFF).
    const points = page.locator(
      '[data-testid^="automation-point-0-instrument-0-6-"]',
    );
    await expect(points).toHaveCount(3);
  });

  test('clicking the lane background adds a new point', async ({ page }) => {
    await loadDemoWithFilterLane(page);
    const before = (await lanePoints(page)).length;
    // The SVG renders wider than the viewport (4-bar default at
    // 36px/step → 2304px) and lives inside an overflow-x:auto
    // wrapper. Dispatch the pointerdown directly inside an evaluate
    // so we can hit any column regardless of where it scrolls.
    await page.evaluate(() => {
      const svg = document.querySelector(
        '[data-testid^="automation-lane-0-"] svg',
      ) as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      const x = rect.left + 80; // 80px in, well inside the lane
      const y = rect.top + rect.height * 0.6;
      svg.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 21, pointerType: 'mouse', button: 0,
        clientX: x, clientY: y,
      }));
    });
    await expect.poll(async () => (await lanePoints(page)).length)
      .toBe(before + 1);
  });

  test('shift-click on a point removes it', async ({ page }) => {
    await loadDemoWithFilterLane(page);
    const before = (await lanePoints(page)).length;
    const firstPoint = page.locator(
      '[data-testid="automation-point-0-instrument-0-6-0"]',
    );
    await expect(firstPoint).toBeVisible();
    await firstPoint.click({ modifiers: ['Shift'] });
    await expect.poll(async () => (await lanePoints(page)).length)
      .toBe(before - 1);
  });

  test('drag a point updates its tick (snaps to step)', async ({ page }) => {
    await loadDemoWithFilterLane(page);
    const before = await lanePoints(page);
    const startTick = before[0].tick;
    // Drag point 0 horizontally by ~144px → +960 ticks → +4 steps.
    await page.evaluate(() => {
      const pt = document.querySelector(
        '[data-testid="automation-point-0-instrument-0-6-0"]',
      ) as SVGElement;
      const svg = pt.closest('svg') as SVGSVGElement;
      const ptRect = pt.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      const x0 = ptRect.left + ptRect.width / 2;
      const y0 = ptRect.top + ptRect.height / 2;
      const x1 = x0 + 144;
      const base = {
        bubbles: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: 1,
      };
      pt.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x0, clientY: y0 }));
      svg.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x1, clientY: y0 }));
      svg.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x1, clientY: y0 }));
    });
    await expect.poll(async () => {
      const pts = await lanePoints(page);
      // After drag + insertion-sorted re-add, the dragged point may
      // have moved to a different index — find by approximate tick.
      const expectedTick = startTick + 960;
      return pts.some((p) => Math.abs(p.tick - expectedTick) <= 240);
    }).toBe(true);
  });

  test('no lanes → nothing renders', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
    // The synth track has no seeded automation, so no lanes section
    // should mount. The component returns nothing when lanes.length
    // === 0, so the wrapper is absent (not just hidden).
    await expect(page.locator('[data-testid="automation-lanes-1"]'))
      .toHaveCount(0);
  });
});
