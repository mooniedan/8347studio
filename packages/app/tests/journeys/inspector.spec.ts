import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/inspector.md.
 *
 * The right-pane inspector reflects the selected track and lets you
 * edit name + color + see plugin / insert / send counts.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / inspector — selected-track sidecar', () => {

  // Inspector pane reachable + populates from the selected track.
  test('inspector shows fields for the selected track', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toBeVisible();
    // Documented fields:
    await expect(page.getByTestId('inspector-stripe')).toBeVisible();
    await expect(page.getByTestId('inspector-name')).toBeVisible();
    await expect(page.getByTestId('inspector-kind')).toBeVisible();
    await expect(page.getByTestId('inspector-plugin')).toBeVisible();
    await expect(page.getByTestId('inspector-insert-count')).toBeVisible();
    await expect(page.getByTestId('inspector-send-count')).toBeVisible();
    await expect(page.getByTestId('inspector-palette')).toBeVisible();
  });

  // "Color — click any of the 8 palette swatches. The stripe updates
  //  everywhere (rail, mixer strip, canvas head, clip borders,
  //  selection rings)."
  test('clicking a palette swatch repaints the track stripe', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
    // The 6th swatch is a known palette colour; we don't pin the
    // hex (palette may evolve) but assert the canvas-head stripe
    // changes after the click.
    const before = await page.getByTestId('canvas-track-stripe')
      .evaluate((el) => (el as HTMLElement).style.background);
    const swatches = page.locator('[data-testid^="inspector-swatch-"]');
    const target = swatches.nth(5);
    await target.click();
    await expect.poll(async () =>
      page.getByTestId('canvas-track-stripe').evaluate(
        (el) => (el as HTMLElement).style.background,
      ),
    ).not.toBe(before);
  });

  // "Press Cmd / Ctrl + \ to collapse the inspector."
  test('inspector collapse persists via the testid hook', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const collapseBtn = page.getByTestId('inspector-collapse');
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();
    // After collapse the body should be hidden / removed.
    await expect(page.getByTestId('inspector-body')).toHaveCount(0);
  });
});
