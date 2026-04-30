import { test, expect, type Page } from '@playwright/test';

// M3 verifies the hybrid bridge wiring:
//   1. Y.Doc edits to track gain land in the engine through the SPSC SAB
//      ring (proves the event channel).
//   2. window.__bridge exposes a debug RPC into the worklet so tests can
//      observe the engine's view without sniffing the audio output.
//
// The slider sets gain in the Y.Doc; engine-bridge.ts writes a SetTrackGain
// event into the SAB; the worklet drains it on the next audio block and
// calls apply_event in wasm. We then read back via debug_track_gain.

async function bridgeReady(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge))).toBe(true);
}

async function readEngineTrackGain(page: Page, track = 0): Promise<number> {
  return page.evaluate(async (t) => {
    const w = window as unknown as { __bridge: { debugTrackGain: (i: number) => Promise<number> } };
    return w.__bridge.debugTrackGain(t);
  }, track);
}

test.describe('phase-1 / M3 hybrid bridge', () => {
  test('engine starts with one track and the engine view of gain is 1.0', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const count = await page.evaluate(async () => {
      const w = window as unknown as { __bridge: { debugTrackCount: () => Promise<number> } };
      return w.__bridge.debugTrackCount();
    });
    expect(count).toBe(1);
    const gain = await readEngineTrackGain(page);
    expect(gain).toBeCloseTo(1.0, 5);
  });

  test('moving the gain slider lands in the engine via SAB', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Drive the slider's input handler directly. Playwright's drag on a
    // type=range input is flaky across platforms; the input event is
    // exactly what the user gesture would dispatch.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="track-gain"]') as HTMLInputElement;
      el.value = '0.42';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // UI mirrors the new value immediately (Y.Doc → Svelte $state).
    await expect(page.locator('[data-testid="track-gain-readout"]')).toHaveText('0.42');

    // Engine view is updated within a few audio blocks. Poll up to 1s.
    await expect
      .poll(async () => readEngineTrackGain(page), { timeout: 2000, intervals: [50, 50, 100] })
      .toBeCloseTo(0.42, 2);
  });
});
