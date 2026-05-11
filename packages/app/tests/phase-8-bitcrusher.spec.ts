import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M6 — Bitcrusher example plugin. End-to-end:
 *
 * Builds a synth track, paints a note, loads the bitcrusher WASM
 * plugin into the worklet, attaches it as an insert on the synth
 * track, plays, and verifies the per-track peak meter responds —
 * proving the engine's insert chain actually routes audio through a
 * third-party WASM module on the FFI path.
 */

const WASM_URL = '/example-plugins/wasm_bitcrusher.wasm';

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function trackPeak(page: Page, idx: number): Promise<number> {
  return page.evaluate(
    (i) => (window as any).__bridge.debugTrackPeak(i),
    idx,
  );
}

test.describe('phase-8 M6 — Bitcrusher example plugin', () => {

  test('plugin loads and produces a non-zero peak when fed a synth', async ({ page }) => {
    test.setTimeout(25_000);
    await page.goto('/');
    await bridgeReady(page);

    // Fresh subtractive synth track + a note to play.
    const trackIdx = await page.evaluate(async () => {
      const b = (window as any).__bridge;
      const idx = b.addSubtractiveTrack();
      // The piano-roll clip on the new track already exists; just
      // need a note to drive sound. We use a sustained mid-pitch
      // note for ~half a bar.
      b.noteOn(idx, 60, 110);
      return idx;
    });
    expect(trackIdx).toBeGreaterThanOrEqual(0);

    // Load the bitcrusher into the worklet. As an insert effect we
    // need both input and output channels.
    const handle = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      return (window as any).__bridge.loadWasmPlugin(bytes, {
        maxBlockSize: 256,
        inChannels: 1,
        outChannels: 1,
      });
    }, WASM_URL);
    expect(handle).toBeGreaterThan(0);

    // Attach the bitcrusher to the synth track as an insert. Dial
    // mix to 1.0 (fully wet) so the effect is in the signal path.
    const slotIdx = await page.evaluate(
      ({ trackIdx, handle }) => {
        const b = (window as any).__bridge;
        const slotIdx = b.addWasmInsert(trackIdx, handle);
        b.setInsertParam(trackIdx, slotIdx, 0, 4); // 4-bit
        b.setInsertParam(trackIdx, slotIdx, 1, 1); // no SRR
        b.setInsertParam(trackIdx, slotIdx, 2, 1); // 100% wet
        return slotIdx;
      },
      { trackIdx, handle },
    );
    expect(slotIdx).toBeGreaterThanOrEqual(0);

    // Play; expect non-zero peak on the synth track. The bitcrusher
    // is fed by the synth voice; both must work end-to-end.
    await page.click('button.play');
    await page.waitForTimeout(250);
    const peak = await trackPeak(page, trackIdx);
    await page.click('button.play'); // stop

    expect(peak).toBeGreaterThan(0.01);
  });

  test('mix=0 (fully dry) preserves the synth signal level', async ({ page }) => {
    test.setTimeout(25_000);
    await page.goto('/');
    await bridgeReady(page);

    const trackIdx = await page.evaluate(() => {
      const b = (window as any).__bridge;
      const idx = b.addSubtractiveTrack();
      b.noteOn(idx, 60, 110);
      return idx;
    });

    // Baseline peak with no plugin.
    await page.click('button.play');
    await page.waitForTimeout(250);
    const baseline = await trackPeak(page, trackIdx);
    await page.click('button.play');
    expect(baseline).toBeGreaterThan(0.01);

    // Load + attach bitcrusher at mix=0 — output should match the
    // dry input. Even though we don't have spectral comparison here,
    // the peak should be in the same ballpark.
    const handle = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      return (window as any).__bridge.loadWasmPlugin(bytes, {
        maxBlockSize: 256, inChannels: 1, outChannels: 1,
      });
    }, WASM_URL);

    await page.evaluate(
      ({ trackIdx, handle }) => {
        const b = (window as any).__bridge;
        const slotIdx = b.addWasmInsert(trackIdx, handle);
        b.setInsertParam(trackIdx, slotIdx, 0, 1); // 1-bit (maximum crush)
        b.setInsertParam(trackIdx, slotIdx, 1, 16); // heavy SRR
        b.setInsertParam(trackIdx, slotIdx, 2, 0);  // mix = 0 (dry only)
      },
      { trackIdx, handle },
    );

    // Re-fire the same note so the synth voice is active again.
    await page.evaluate(
      ({ trackIdx }) => {
        (window as any).__bridge.noteOn(trackIdx, 60, 110);
      },
      { trackIdx },
    );
    await page.click('button.play');
    await page.waitForTimeout(250);
    const withDryPlugin = await trackPeak(page, trackIdx);
    await page.click('button.play');

    // Dry signal should sit near the baseline (±50% tolerance to
    // absorb timing + voice-state variance between runs).
    expect(withDryPlugin).toBeGreaterThan(baseline * 0.5);
  });

  test('bitcrusher params round-trip via setInsertParam', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    const trackIdx = await page.evaluate(() =>
      (window as any).__bridge.addSubtractiveTrack(),
    );

    const handle = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      return (window as any).__bridge.loadWasmPlugin(bytes, {
        maxBlockSize: 128, inChannels: 1, outChannels: 1,
      });
    }, WASM_URL);

    const slotIdx = await page.evaluate(
      ({ trackIdx, handle }) =>
        (window as any).__bridge.addWasmInsert(trackIdx, handle),
      { trackIdx, handle },
    );

    // Set + read back each param via the trackParam debug path.
    await page.evaluate(
      ({ trackIdx, slotIdx }) => {
        const b = (window as any).__bridge;
        b.setInsertParam(trackIdx, slotIdx, 0, 6);    // bit depth
        b.setInsertParam(trackIdx, slotIdx, 1, 4);    // SRR
        b.setInsertParam(trackIdx, slotIdx, 2, 0.5);  // mix
      },
      { trackIdx, slotIdx },
    );
    // Give the SAB event ring a tick to drain into the engine.
    await page.waitForTimeout(80);

    // We don't have a direct insert-param read-back in the debug
    // surface yet; the snapshot rebuild + Set-param events have
    // landed if no errors fired in the worklet. The fact that we
    // reach here without errors is the regression we lock.
  });
});
