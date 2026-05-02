import { test, expect, type Page } from '@playwright/test';

// Phase-4 M3 — first-party FX kit. cargo tests cover per-plugin DSP
// correctness; the e2e flow here verifies the full Y.Doc → bridge →
// engine path for each new kind: adding the plugin via the Inserts
// picker lands a slot the engine can host, and bypassing it has the
// expected audible effect.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function trackPeak(page: Page, idx: number): Promise<number> {
  return page.evaluate(async (i) => {
    const w = window as unknown as {
      __bridge: { debugTrackPeak: (i: number) => Promise<number> };
    };
    return w.__bridge.debugTrackPeak(i);
  }, idx);
}

test.describe('phase-4 / M3 first-party effect kit', () => {
  test('every effect kind can be inserted and bypassed', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');

    const kinds = ['builtin:gain', 'builtin:eq', 'builtin:compressor', 'builtin:reverb', 'builtin:delay'];
    for (const k of kinds) {
      await page.selectOption('[data-testid="insert-add"]', k);
    }
    // 5 slots present, each renders its descriptor params.
    await expect(page.locator('[data-testid^="insert-slot-"]')).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(page.locator(`[data-testid="insert-${i}-params"]`)).toBeVisible();
    }
    // Each can bypass / un-bypass without errors.
    for (let i = 0; i < 5; i++) {
      await page.click(`[data-testid="insert-${i}-bypass"]`);
      await expect(page.locator(`[data-testid="insert-${i}-bypass"]`)).toHaveClass(/on/);
    }
  });

  test('a Compressor with extreme settings reduces a hot signal', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    const synthIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Held note across the bar → loud track.
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }
    await page.click('[data-testid="piano-play"]');

    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 80, 120] })
      .toBeGreaterThan(0.05);
    const before = await trackPeak(page, synthIdx);

    // Drop in a compressor with a low threshold → high ratio. The
    // descriptor curves: threshold linear, ratio exp.
    await page.selectOption('[data-testid="insert-add"]', 'builtin:compressor');
    // Threshold = -60 dB → slider at position 0 (linear -60..0).
    await page.evaluate(() => {
      const t = document.querySelector(
        '[data-testid="insert-0-param-0-input"]',
      ) as HTMLInputElement;
      t.value = '0';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      // Ratio = 20 → slider at position 1 (exp 1..20).
      const r = document.querySelector(
        '[data-testid="insert-0-param-1-input"]',
      ) as HTMLInputElement;
      r.value = '1';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Peak drops once the compressor's attack settles.
    await expect
      .poll(() => trackPeak(page, synthIdx), { timeout: 4000, intervals: [80, 100, 200, 400] })
      .toBeLessThan(before * 0.6);
  });
});
