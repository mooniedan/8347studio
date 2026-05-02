import { test, expect, type Page } from '@playwright/test';

// Phase-5 M2 — OPFS content-addressed asset store + register_asset
// path. The OPFS half persists across reload; the engine half lets
// the host upload PCM that Audio-track regions can sample from.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

test.describe('phase-5 / M2 OPFS asset store + engine register_asset', () => {
  test('putBytes hashes deterministically and persists across reload', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    const hash = await page.evaluate(async () => {
      const w = window as unknown as {
        __bridge: { assetStorePut: (bytes: Uint8Array) => Promise<string> };
      };
      // Identifiable byte pattern.
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42, 0x42, 0x42, 0x42]);
      return w.__bridge.assetStorePut(bytes);
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const presentBefore = await page.evaluate(
      async (h) => {
        const w = window as unknown as {
          __bridge: { assetStoreHas: (h: string) => Promise<boolean> };
        };
        return w.__bridge.assetStoreHas(h);
      },
      hash,
    );
    expect(presentBefore).toBe(true);

    // Putting the same bytes again returns the same hash and doesn't
    // duplicate the file.
    const hash2 = await page.evaluate(async () => {
      const w = window as unknown as {
        __bridge: { assetStorePut: (bytes: Uint8Array) => Promise<string> };
      };
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42, 0x42, 0x42, 0x42]);
      return w.__bridge.assetStorePut(bytes);
    });
    expect(hash2).toBe(hash);

    await page.reload();
    await bridgeReady(page);

    const presentAfter = await page.evaluate(
      async (h) => {
        const w = window as unknown as {
          __bridge: {
            assetStoreHas: (h: string) => Promise<boolean>;
            assetStoreList: () => Promise<string[]>;
          };
        };
        const list = await w.__bridge.assetStoreList();
        return { has: await w.__bridge.assetStoreHas(h), list };
      },
      hash,
    );
    expect(presentAfter.has).toBe(true);
    expect(presentAfter.list).toContain(hash);
  });

  test('registerAssetPcm uploads PCM into the engine cache', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    const initialCount = await page.evaluate(async () => {
      const w = window as unknown as { __bridge: { debugAssetCount: () => Promise<number> } };
      return w.__bridge.debugAssetCount();
    });
    expect(initialCount).toBe(0);

    await page.evaluate(async () => {
      const w = window as unknown as {
        __bridge: { registerAssetPcm: (id: number, pcm: Float32Array) => Promise<void> };
      };
      const pcm = new Float32Array(1024);
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 50);
      await w.__bridge.registerAssetPcm(7, pcm);
    });

    // Asset cache visible to debug RPC. Worklet processes the
    // postMessage on the audio thread; poll a moment.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const w = window as unknown as {
              __bridge: { debugAssetCount: () => Promise<number> };
            };
            return w.__bridge.debugAssetCount();
          }),
        { timeout: 3000, intervals: [80, 100, 200] },
      )
      .toBe(1);
  });
});
