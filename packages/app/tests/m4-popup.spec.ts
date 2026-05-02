import { test, expect, type Page } from '@playwright/test';

// Phase-6 M4 — popup windows. Click the Mixer's "pop out" button →
// a `?panel=mixer` window.open opens; that page boots the satellite
// shell which bidirectional-syncs with root over BroadcastChannel.
// Adjusting the master gain in the popup reflects in root's engine
// via the satellite → root → engine snapshot path.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

test.describe('phase-6 / M4 popup windows', () => {
  test('Mixer popup mirrors root and writes back via Y.Doc sync', async ({ context, page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Mixer popup opens via window.open. Capture the new page event.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="mixer-popout"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');

    // Popup renders a Mixer with at least one strip (the default
    // step-seq track) once the snapshot lands.
    await expect(popup.locator('[data-testid="mixer"]')).toBeVisible();
    await expect(popup.locator('[data-testid="mixer-strip-0"]')).toBeVisible();

    // Drive master gain to 0.27 from the popup.
    await popup.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="mixer-master-gain"]',
      ) as HTMLInputElement;
      el.value = '0.27';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Satellite Y.Doc → BroadcastChannel → root Y.Doc → engine bridge
    // → SAB → engine. debug_master_gain reads back the new value.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { debugMasterGain: () => Promise<number> };
            };
            return w.__bridge.debugMasterGain();
          }),
        { timeout: 5000, intervals: [80, 120, 250, 500] },
      )
      .toBeCloseTo(0.27, 2);

    // Closing the popup leaves root running.
    await popup.close();
    expect(
      await page.evaluate(async () => {
        const w = window as unknown as {
          __bridge: { debugMasterGain: () => Promise<number> };
        };
        return w.__bridge.debugMasterGain();
      }),
    ).toBeCloseTo(0.27, 2);
  });

  test('mixer-popout button is reachable from root', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.locator('[data-testid="mixer-popout"]')).toBeVisible();
  });
});
