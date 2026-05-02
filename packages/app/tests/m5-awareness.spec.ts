import { test, expect, type Page } from '@playwright/test';

// Phase-6 M5 — cross-window awareness. Root publishes its current
// playhead tick on every animation frame (via attachRootSync's
// awareness path); satellites read the published state without
// touching the persistent Y.Doc.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

test.describe('phase-6 / M5 cross-window awareness', () => {
  test('root publishes a non-zero playhead tick while transport is on', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-synth-track"]');
    for (let col = 0; col < 16; col++) {
      await page.click(`[data-testid="piano-cell-60-${col}"]`);
    }

    // Idle: published tick stays at zero.
    expect(
      await page.evaluate(() => {
        const w = window as unknown as { __bridge: { publishedPlayheadTick: () => number } };
        return w.__bridge.publishedPlayheadTick();
      }),
    ).toBe(0);

    // Start transport. The awareness publisher feeds engine tick →
    // shared awareness state at ~rAF rate.
    await page.evaluate(() => {
      const w = window as unknown as { __bridge: { setTransport: (p: boolean) => void } };
      w.__bridge.setTransport(true);
    });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { publishedPlayheadTick: () => number };
            };
            return w.__bridge.publishedPlayheadTick();
          }),
        { timeout: 4000, intervals: [80, 100, 200] },
      )
      .toBeGreaterThan(100);
  });

  test('a popup mixer receives root awareness via BroadcastChannel', async ({ context, page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Open the mixer popup so a satellite is on the channel.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="mixer-popout"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    await expect(popup.locator('[data-testid="mixer"]')).toBeVisible();

    // Subscribe in the popup BEFORE root starts publishing.
    await popup.evaluate(() => {
      const win = window as unknown as { __awareness?: { ticks: number[] } };
      win.__awareness = { ticks: [] };
      const ch = new BroadcastChannel('8347-studio-sync');
      ch.onmessage = (ev) => {
        const m = ev.data as { type?: string; state?: { playheadTick?: number } };
        if (m.type === 'awareness' && typeof m.state?.playheadTick === 'number') {
          win.__awareness!.ticks.push(m.state.playheadTick);
        }
      };
    });

    // Drive root transport.
    await page.evaluate(() => {
      const w = window as unknown as { __bridge: { setTransport: (p: boolean) => void } };
      w.__bridge.setTransport(true);
    });

    await expect
      .poll(
        async () =>
          popup.evaluate(() => {
            const win = window as unknown as { __awareness?: { ticks: number[] } };
            return win.__awareness?.ticks.length ?? 0;
          }),
        { timeout: 4000, intervals: [100, 150, 250] },
      )
      .toBeGreaterThan(2);

    // The values are growing (transport advances).
    const ticks: number[] = await popup.evaluate(() => {
      const win = window as unknown as { __awareness?: { ticks: number[] } };
      return win.__awareness?.ticks ?? [];
    });
    const last = ticks[ticks.length - 1];
    const first = ticks[0];
    expect(last).toBeGreaterThan(first);
  });
});
