import { test, expect, type Page } from '@playwright/test';

// Phase-5 M3 — drag-drop import + region UI. Headline path:
// generate a small WAV in JS, hand it to importAssetIntoTrack, verify
// the region lands in the project, the asset registers in the engine,
// and the track produces audio when transport plays.

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

// Sine-wave WAV generator (16-bit PCM mono). Matches the engine's
// 48 kHz default so resampling differences don't muddy the test.
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
    const setU32 = (v: number) => {
      dv.setUint32(p, v, true);
      p += 4;
    };
    const setU16 = (v: number) => {
      dv.setUint16(p, v, true);
      p += 2;
    };
    setStr('RIFF');
    setU32(36 + dataSize);
    setStr('WAVE');
    setStr('fmt ');
    setU32(16);
    setU16(1); // PCM
    setU16(1); // mono
    setU32(sampleRate);
    setU32(sampleRate * blockAlign);
    setU16(blockAlign);
    setU16(16); // bits per sample
    setStr('data');
    setU32(dataSize);
    for (let i = 0; i < frames; i++) {
      const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
      const clamped = Math.max(-1, Math.min(1, s));
      dv.setInt16(p, Math.round(clamped * 0x7fff), true);
      p += 2;
    }
    return new Uint8Array(ab);
  };
}

test.describe('phase-5 / M3 drag-drop import + region UI', () => {
  test('importing a WAV places a region and produces audio', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // The Audio track view renders an "empty" placeholder before any
    // region exists.
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-empty"]`),
    ).toBeVisible();

    // Generate a 1-second 1 kHz WAV in-page and import it. We have to
    // build the WAV inside page.evaluate because Uint8Array transfer
    // between Playwright host and page is awkward.
    await page.evaluate(
      async ({ idx, makeWavSrc }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const makeWav = new Function('args', `return (${makeWavSrc})(args)`) as (a: unknown) => Uint8Array;
        const bytes = makeWav({ seconds: 1, freq: 1000, sampleRate: 48000 });
        const w = window as unknown as {
          __bridge: {
            importAssetIntoTrack: (
              i: number,
              b: Uint8Array,
              n: string,
            ) => Promise<{ hash: string }>;
          };
        };
        await w.__bridge.importAssetIntoTrack(idx, bytes, 'test-sine.wav');
      },
      { idx: audioIdx, makeWavSrc: makeSineWavSnippet().toString() },
    );

    // Region appears in the Y.Doc.
    const regions = await page.evaluate(async (i) => {
      const w = window as unknown as {
        __bridge: { getAudioRegions: (i: number) => unknown[] };
      };
      return w.__bridge.getAudioRegions(i);
    }, audioIdx);
    expect(regions).toHaveLength(1);

    // Region renders in the AudioTrackView.
    await expect(
      page.locator(`[data-testid="audio-region-${audioIdx}-0"]`),
    ).toBeVisible();

    // Engine asset cache picks up the PCM (registerMissingAssets fires
    // on the next snapshot rebuild).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as unknown as {
              __bridge: { debugAssetCount: () => Promise<number> };
            };
            return w.__bridge.debugAssetCount();
          }),
        { timeout: 4000, intervals: [80, 100, 200] },
      )
      .toBeGreaterThanOrEqual(1);

    // Transport-on → engine renders the region; track peak climbs.
    await page.evaluate(() => {
      const w = window as unknown as { __bridge: { setTransport: (p: boolean) => void } };
      w.__bridge.setTransport(true);
    });
    await expect
      .poll(() => trackPeak(page, audioIdx), { timeout: 4000, intervals: [80, 100, 200] })
      .toBeGreaterThan(0.05);
  });

  test('importing the same WAV twice deduplicates by hash', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    const hashes = await page.evaluate(
      async ({ idx, makeWavSrc }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const makeWav = new Function('args', `return (${makeWavSrc})(args)`) as (a: unknown) => Uint8Array;
        const bytes = makeWav({ seconds: 0.2, freq: 800, sampleRate: 48000 });
        const w = window as unknown as {
          __bridge: {
            importAssetIntoTrack: (
              i: number,
              b: Uint8Array,
              n: string,
            ) => Promise<{ hash: string }>;
          };
        };
        const a = await w.__bridge.importAssetIntoTrack(idx, bytes, 'a.wav');
        const b = await w.__bridge.importAssetIntoTrack(idx, bytes, 'a.wav');
        return [a.hash, b.hash];
      },
      { idx: audioIdx, makeWavSrc: makeSineWavSnippet().toString() },
    );
    expect(hashes[0]).toBe(hashes[1]);
    // Two regions referencing one asset.
    const regions = await page.evaluate(async (i) => {
      const w = window as unknown as {
        __bridge: { getAudioRegions: (i: number) => { assetHash: string }[] };
      };
      return w.__bridge.getAudioRegions(i);
    }, audioIdx);
    expect(regions).toHaveLength(2);
    expect(regions[0].assetHash).toBe(regions[1].assetHash);
  });
});
