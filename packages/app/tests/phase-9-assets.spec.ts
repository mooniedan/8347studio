import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';

import { createServer } from 'sync-server';

/**
 * Phase 9 M2 — cloud asset bucket end-to-end.
 *
 * Peer A imports a WAV → asset lands in OPFS, uploads to the bucket
 * via fire-and-forget PUT, region added in the Y.Doc. Peer B opens
 * the same room → Y.Doc sync delivers the region → boot's
 * registerMissingAssets calls ensureLocal → bytes flow from bucket
 * to OPFS → audio plays on B.
 */

const collabTest = test.extend<{
  syncBase: string;
  urlFor: (roomId: string) => string;
}>({
  syncBase: async ({}, use) => {
    const srv = await createServer({ port: 0 });
    try {
      await use(`ws://127.0.0.1:${srv.port}`);
    } finally {
      await srv.close();
    }
  },
  urlFor: async ({ syncBase }, use) => {
    const httpBase = syncBase.replace(/^ws/, 'http');
    use((roomId: string) =>
      `/?room=${encodeURIComponent(roomId)}&syncBase=${encodeURIComponent(syncBase)}&assetBase=${encodeURIComponent(httpBase)}`,
    );
  },
});

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function makeContext(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
  return { ctx, page };
}

// Tiny 48 kHz mono 16-bit PCM WAV — 1 kHz sine for 0.25 s. Used as
// the canonical "test asset" because it decodes cleanly via
// decodeAudioData on any browser.
function makeSineWavSnippet() {
  return ({ seconds, freq, sampleRate }: { seconds: number; freq: number; sampleRate: number }) => {
    const frames = Math.round(seconds * sampleRate);
    const blockAlign = 2;
    const dataSize = frames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    let p = 0;
    const setStr = (s: string) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i));
      p += s.length;
    };
    const setU32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
    const setU16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
    setStr('RIFF'); setU32(36 + dataSize); setStr('WAVE');
    setStr('fmt '); setU32(16); setU16(1); setU16(1);
    setU32(sampleRate); setU32(sampleRate * blockAlign); setU16(blockAlign); setU16(16);
    setStr('data'); setU32(dataSize);
    for (let i = 0; i < frames; i++) {
      const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
      dv.setInt16(p, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true);
      p += 2;
    }
    return new Uint8Array(ab);
  };
}

collabTest.describe('phase-9 M2 — cloud asset bucket', () => {

  collabTest('A imports a WAV → B receives the asset via the bucket', async ({ browser, urlFor }) => {
    collabTest.setTimeout(30_000);
    const roomId = `as-${Math.random().toString(36).slice(2, 8)}`;
    const { ctx: ctxA, page: a } = await makeContext(browser);
    const { ctx: ctxB, page: b } = await makeContext(browser);
    try {
      await a.goto(urlFor(roomId));
      await bridgeReady(a);

      // Add an audio track on A, then import the test WAV.
      await a.click('[data-testid="add-audio-track"]');
      const audioIdx = await a.evaluate(() => {
        const w = window as unknown as { __project: { trackCount: number } };
        return w.__project.trackCount - 1;
      });

      const hash: string = await a.evaluate(
        async ({ idx, makeWavSrc }) => {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
          const makeWav = new Function('args', `return (${makeWavSrc})(args)`) as (a: unknown) => Uint8Array;
          const bytes = makeWav({ seconds: 0.25, freq: 1000, sampleRate: 48000 });
          const w = window as unknown as {
            __bridge: {
              importAssetIntoTrack: (i: number, b: Uint8Array, n: string) => Promise<{ hash: string }>;
            };
          };
          const out = await w.__bridge.importAssetIntoTrack(idx, bytes, 'test-sine.wav');
          return out.hash;
        },
        { idx: audioIdx, makeWavSrc: makeSineWavSnippet().toString() },
      );

      // A's asset is in OPFS immediately.
      await expect.poll(() => a.evaluate(
        (h) => (window as unknown as { __bridge: { assetStoreHas: (h: string) => Promise<boolean> } })
          .__bridge.assetStoreHas(h),
        hash,
      )).toBe(true);

      // B joins the same room. Wait for sync, then poll the OPFS
      // store — `ensureLocal` should pull the bytes from the bucket.
      await b.goto(urlFor(roomId));
      await bridgeReady(b);

      await expect.poll(() => b.evaluate(
        (h) => (window as unknown as { __bridge: { assetStoreHas: (h: string) => Promise<boolean> } })
          .__bridge.assetStoreHas(h),
        hash,
      ), { timeout: 10_000 }).toBe(true);

      // Belt-and-braces: B's engine should also see the registered
      // asset, which proves the full register-after-fetch round trip.
      await expect.poll(() => b.evaluate(
        () => (window as unknown as { __bridge: { debugAssetCount: () => Promise<number> } })
          .__bridge.debugAssetCount(),
      ), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
