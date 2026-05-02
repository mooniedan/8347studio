import { test, expect, type Page } from '@playwright/test';

// Phase-6 M3 — Document Picture-in-Picture transport. Document PIP
// requires a real user gesture and is Chromium-only; opening an
// actual PIP window in headless test runs is brittle. We exercise
// the bindings the panel calls (pipPlay / pipStop) and verify they
// drive the engine, plus assert the toolbar button + feature-detect
// landed.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

test.describe('phase-6 / M3 PIP transport', () => {
  test('Open Transport button is visible and reports PIP support', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const supported = await page.evaluate(() => {
      const w = window as unknown as { __bridge: { isPipSupported: () => boolean } };
      return w.__bridge.isPipSupported();
    });
    // Headless Chromium typically exposes documentPictureInPicture
    // (the API is on by default since 2024). Either way the button
    // must be visible — disabled when unsupported, enabled otherwise.
    const btn = page.locator('[data-testid="open-pip"]');
    await expect(btn).toBeVisible();
    if (!supported) {
      await expect(btn).toBeDisabled();
    }
  });

  test('PIP play binding starts the engine', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }

    // The PIP panel calls these via its bindings closure; emulate a
    // Play click in the PIP window.
    await page.evaluate(() => {
      const w = window as unknown as { __bridge: { pipPlay: () => void } };
      w.__bridge.pipPlay();
    });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { debugCurrentTick: () => Promise<number> };
            };
            return w.__bridge.debugCurrentTick();
          }),
        { timeout: 3000, intervals: [80, 100, 200] },
      )
      .toBeGreaterThan(100);
  });

  test('PIP stop binding halts the engine', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }

    await page.evaluate(() => {
      const w = window as unknown as { __bridge: { pipPlay: () => void } };
      w.__bridge.pipPlay();
    });
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { debugCurrentTick: () => Promise<number> };
            };
            return w.__bridge.debugCurrentTick();
          }),
        { timeout: 3000 },
      )
      .toBeGreaterThan(100);

    await page.evaluate(() => {
      const w = window as unknown as { __bridge: { pipStop: () => void } };
      w.__bridge.pipStop();
    });

    // Engine resets tick to 0 on stop.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { debugCurrentTick: () => Promise<number> };
            };
            return w.__bridge.debugCurrentTick();
          }),
        { timeout: 3000 },
      )
      .toBe(0);
  });
});
