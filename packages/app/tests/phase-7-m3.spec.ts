import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 7 M3 — track color, master meter, mono numerics, BPM drag.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('phase-7 M3 — track color, master meter, mono numerics', () => {

  test('canvas head shows the selected track color and name', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const stripe = page.getByTestId('canvas-track-stripe');
    const name = page.getByTestId('canvas-track-name');
    await expect(stripe).toBeVisible();
    await expect(name).toBeVisible();
    const bg = await stripe.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Should be a real color, not transparent or default.
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });

  test('TrackList rows carry per-track color stripes', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // The demo song has multiple tracks; pull the first two stripes and
    // confirm they're distinct, well-formed colors.
    const stripes = page.locator('[data-testid^="track-row-"] .stripe');
    await expect(stripes.first()).toBeVisible();
    const colors = await stripes.evaluateAll((els) =>
      els.slice(0, 2).map((el) => getComputedStyle(el as HTMLElement).backgroundColor),
    );
    for (const c of colors) {
      expect(c).not.toBe('rgba(0, 0, 0, 0)');
      expect(c).toMatch(/^rgb/);
    }
    if (colors.length >= 2) expect(colors[0]).not.toBe(colors[1]);
  });

  test('master meter is mounted in the top bar', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const meter = page.getByTestId('master-meter');
    await expect(meter).toBeVisible();
    await expect(page.getByTestId('master-meter-l')).toBeVisible();
    await expect(page.getByTestId('master-meter-r')).toBeVisible();
    await expect(page.getByTestId('master-meter-peak')).toBeVisible();
  });

  test('master meter peak readout uses mono font', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const family = await page.getByTestId('master-meter-peak').evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(family).toContain('IBM Plex Mono');
  });

  test('BPM input + tick readout use mono font', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const bpmFamily = await page.getByTestId('bpm-input').evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(bpmFamily).toContain('IBM Plex Mono');
    const tickFamily = await page.getByTestId('current-tick').evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(tickFamily).toContain('IBM Plex Mono');
  });

  test('BPM click-drag (vertical) increases the BPM', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Simulate pointer-down + move-up + up on the bpm-input. Use
    // dispatchEvent so Playwright's mouse → pointer synthesis doesn't
    // get in the way of setPointerCapture (same approach as the
    // Numeric drag test).
    const startValue = await page.getByTestId('bpm-input').inputValue();
    await page.getByTestId('bpm-input').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const fire = (type: string, y: number) => el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
          clientX: cx, clientY: y, bubbles: true,
        }),
      );
      fire('pointerdown', cy);
      fire('pointermove', cy - 15);
      fire('pointerup', cy - 15);
    });
    // Drag up 15px @ step=1 → BPM should be ~start + 15.
    const endValue = Number(await page.getByTestId('bpm-input').inputValue());
    expect(endValue).toBeGreaterThan(Number(startValue));
    expect(endValue - Number(startValue)).toBeGreaterThanOrEqual(10);
  });

  test('BPM wheel-up nudges the value', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const bpm = page.getByTestId('bpm-input');
    const before = Number(await bpm.inputValue());
    await bpm.hover();
    await page.mouse.wheel(0, -1);
    const after = Number(await bpm.inputValue());
    expect(after).toBeGreaterThan(before);
  });
});
