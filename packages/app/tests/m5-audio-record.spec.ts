import { test, expect, type Page } from '@playwright/test';

// Phase-5 M5 — audio recording. The live mic flow (getUserMedia +
// ScriptProcessorNode) requires hardware + permission and is exercised
// manually. The data path the live recorder feeds into is
// recordPcmIntoTrack — the test fakes the captured PCM and verifies
// the asset import + region creation flow lands the recording on the
// armed Audio track.

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

test.describe('phase-5 / M5 audio recording', () => {
  test('recordPcmIntoTrack creates an audible region from synthetic PCM', async ({
    page,
  }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });

    // Simulate a 1 s 440 Hz sine "recording" at the engine sample rate.
    // recordPcmIntoTrack wraps the Float32 PCM in a WAV and runs it
    // through the M3 import path — same code the live recorder will
    // call after stopping.
    await page.evaluate(async ({ idx }) => {
      const w = window as unknown as {
        __bridge: {
          recordPcmIntoTrack: (
            i: number,
            pcm: Float32Array,
            sr: number,
          ) => Promise<{ hash: string }>;
        };
      };
      const sampleRate = 48_000;
      const frames = sampleRate; // 1 second
      const pcm = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        pcm[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      }
      await w.__bridge.recordPcmIntoTrack(idx, pcm, sampleRate);
    }, { idx: audioIdx });

    // Region landed on the track.
    await expect(
      page.locator(`[data-testid="audio-region-${audioIdx}-0"]`),
    ).toBeVisible();

    // Engine asset cache picked up the PCM (registerMissingAssets
    // ran via the snapshot rebuild).
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

    // Transport-on → engine renders the recorded region; track peak
    // climbs above the noise floor.
    await page.evaluate(() => {
      const w = window as unknown as { __bridge: { setTransport: (p: boolean) => void } };
      w.__bridge.setTransport(true);
    });
    await expect
      .poll(() => trackPeak(page, audioIdx), { timeout: 4000, intervals: [80, 100, 200] })
      .toBeGreaterThan(0.05);
  });

  test('Record button on the Audio track is reachable', async ({ page }) => {
    // Live recording needs hardware permission; we just verify the
    // affordance is wired so a manual test can reach it.
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number } };
      return w.__project.trackCount - 1;
    });
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-record"]`),
    ).toBeVisible();
  });
});
