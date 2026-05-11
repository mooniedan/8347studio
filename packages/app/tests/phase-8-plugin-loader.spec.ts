import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M3a — JS plugin loader. Loads the reference gain plugin
 * (`examples/wasm-gain-plugin/`), proves it runs end-to-end in the
 * browser, and locks the failure modes (integrity mismatch, frames
 * over max-block size).
 */

const WASM_URL = '/example-plugins/wasm_gain_plugin.wasm';

async function gotoApp(page: Page) {
  // The loader runs in the page context; we just need any page to
  // get a browser tab with the right CSP + fetch behaviour. The
  // root app is fine — it doesn't matter that the loader isn't
  // wired into the engine yet (that's M3b).
  await page.goto('/');
}

test.describe('phase-8 M3a — plugin loader', () => {

  test('loads the gain plugin and scales a sine wave by 0.5', async ({ page }) => {
    await gotoApp(page);

    const result = await page.evaluate(async (wasmUrl) => {
      const mod = await import('/src/lib/plugin-loader.ts');
      // Fetch + hash the WASM to build a valid manifest the loader
      // will accept. Real callers get the manifest from a registry,
      // but for the loader unit we exercise it directly.
      const resp = await fetch(wasmUrl);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const hash = await mod.sha256(bytes);
      const manifest = {
        id: 'com.example.gain',
        name: 'Gain',
        version: '0.1.0',
        kind: 'effect' as const,
        wasm: wasmUrl,
        wasmIntegrity: `sha256-${hash}`,
        params: [
          { id: 'gain', name: 'Gain', min: 0, max: 1, default: 1, curve: 'linear' as const },
        ],
      };
      const plugin = await mod.loadPlugin(manifest, {
        maxBlockSize: 256,
        sampleRate: 48000,
        inChannels: 1,
        outChannels: 1,
      });
      plugin.init();
      plugin.setParam(0, 0.5);

      // Feed a unit-amplitude sine for 64 frames; expect 0.5×
      // amplitude on the way out.
      const N = 64;
      const inp = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        inp[i] = Math.sin((2 * Math.PI * i) / N);
      }
      const out = new Float32Array(N);
      plugin.process([inp], [out], N);
      // Peak should be 0.5 ± a tiny margin.
      let peak = 0;
      for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));

      // Read the param back.
      const readBack = plugin.getParam(0);

      plugin.destroy();
      return { peak, readBack };
    }, WASM_URL);

    expect(result.peak).toBeGreaterThan(0.48);
    expect(result.peak).toBeLessThan(0.52);
    expect(result.readBack).toBeCloseTo(0.5, 5);
  });

  test('rejects a manifest whose integrity hash does not match', async ({ page }) => {
    await gotoApp(page);
    const err = await page.evaluate(async (wasmUrl) => {
      const mod = await import('/src/lib/plugin-loader.ts');
      try {
        await mod.loadPlugin({
          id: 'com.example.gain',
          name: 'Gain',
          version: '0.1.0',
          kind: 'effect',
          wasm: wasmUrl,
          // Bogus 44-char base64 → valid SRI shape, wrong content.
          wasmIntegrity: 'sha256-' + 'A'.repeat(43) + '=',
          params: [],
        }, { maxBlockSize: 256, inChannels: 0, outChannels: 1 });
        return null;
      } catch (e) {
        const err = e as Error;
        return { name: err.name, message: err.message };
      }
    }, WASM_URL);
    expect(err).not.toBeNull();
    expect(err!.name).toBe('IntegrityError');
    expect(err!.message).toMatch(/expected sha256-AAA/);
  });

  test('rejects frames > maxBlockSize', async ({ page }) => {
    await gotoApp(page);
    const errMsg = await page.evaluate(async (wasmUrl) => {
      const mod = await import('/src/lib/plugin-loader.ts');
      const resp = await fetch(wasmUrl);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const hash = await mod.sha256(bytes);
      const plugin = await mod.loadPlugin({
        id: 'com.example.gain', name: 'Gain', version: '0.1.0', kind: 'effect',
        wasm: wasmUrl, wasmIntegrity: `sha256-${hash}`,
        params: [{ id: 'gain', name: 'Gain', min: 0, max: 1, default: 1, curve: 'linear' }],
      }, { maxBlockSize: 64, inChannels: 1, outChannels: 1 });
      plugin.init();
      try {
        plugin.process([new Float32Array(128)], [new Float32Array(128)], 128);
        return null;
      } catch (e) {
        return (e as Error).message;
      } finally {
        plugin.destroy();
      }
    }, WASM_URL);
    expect(errMsg).toMatch(/maxBlockSize/);
  });

  test('destroy() is idempotent', async ({ page }) => {
    await gotoApp(page);
    const ok = await page.evaluate(async (wasmUrl) => {
      const mod = await import('/src/lib/plugin-loader.ts');
      const resp = await fetch(wasmUrl);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const hash = await mod.sha256(bytes);
      const plugin = await mod.loadPlugin({
        id: 'com.example.gain', name: 'Gain', version: '0.1.0', kind: 'effect',
        wasm: wasmUrl, wasmIntegrity: `sha256-${hash}`,
        params: [{ id: 'gain', name: 'Gain', min: 0, max: 1, default: 1, curve: 'linear' }],
      }, { maxBlockSize: 128, inChannels: 1, outChannels: 1 });
      plugin.init();
      plugin.destroy();
      plugin.destroy(); // should be a no-op
      return true;
    }, WASM_URL);
    expect(ok).toBe(true);
  });
});
