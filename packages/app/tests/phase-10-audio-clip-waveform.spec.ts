import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M3a — audio-clip horizontal timeline + waveform thumbnail.
 *
 * The audio track view used to be a plain list of region records.
 * It's now a horizontal timeline where each region is a positioned
 * block (left = `startTick * PX_PER_TICK`, width = `lengthTicks *
 * PX_PER_TICK`), with a downsampled waveform painted into a canvas
 * thumbnail cached per asset hash.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

/// Build a small 0.5s 48kHz mono sine WAV inside the page and import
/// it into the audio track at index `trackIdx`. Returns the matching
/// region's `lengthTicks` once the Y.Doc shows it.
async function importSineWav(page: Page, trackIdx: number) {
  await page.evaluate(async (idx) => {
    const sr = 48_000;
    const seconds = 0.5;
    const frames = Math.round(seconds * sr);
    const dataLen = frames * 2;
    const ab = new ArrayBuffer(44 + dataLen);
    const dv = new DataView(ab);
    let p = 0;
    const wStr = (s: string) => { for (const c of s) dv.setUint8(p++, c.charCodeAt(0)); };
    const wU32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
    const wU16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
    wStr('RIFF'); wU32(36 + dataLen); wStr('WAVE'); wStr('fmt ');
    wU32(16); wU16(1); wU16(1); wU32(sr); wU32(sr * 2); wU16(2); wU16(16);
    wStr('data'); wU32(dataLen);
    for (let i = 0; i < frames; i++) {
      const s = Math.sin((2 * Math.PI * 1000 * i) / sr) * 0.5;
      dv.setInt16(p + i * 2, Math.round(s * 0x7fff), true);
    }
    const bytes = new Uint8Array(ab);
    await (window as any).__bridge.importAssetIntoTrack(idx, bytes, 'sine1k.wav');
  }, trackIdx);
}

test.describe('phase-10 M3a — audio timeline + waveform thumbnail', () => {

  test('region renders inside the horizontal timeline (not a list)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__project.trackCount - 1,
    );
    await importSineWav(page, audioIdx);
    await page.click(`[data-testid="track-row-${audioIdx}"]`);

    const timeline = page.locator(`[data-testid="audio-timeline-${audioIdx}"]`);
    await expect(timeline).toBeVisible();

    const region = page.locator(`[data-testid="audio-region-${audioIdx}-0"]`);
    await expect(region).toBeVisible();
    const box = await region.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(20);
  });

  test('waveform canvas mounts inside the region and paints peaks', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__project.trackCount - 1,
    );
    await importSineWav(page, audioIdx);
    await page.click(`[data-testid="track-row-${audioIdx}"]`);
    const canvas = page.locator(
      `[data-testid="audio-region-${audioIdx}-0"] canvas`,
    );
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    // Decode + bucket is async; poll until non-transparent pixels
    // appear in the backing store.
    await expect.poll(async () => {
      return canvas.evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext('2d');
        if (!ctx) return 0;
        const data = ctx.getImageData(0, 0, el.width, el.height).data;
        let lit = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
        return lit;
      });
    }, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('region width scales with lengthTicks (pixel-per-tick)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__project.trackCount - 1,
    );
    await importSineWav(page, audioIdx);
    await page.click(`[data-testid="track-row-${audioIdx}"]`);

    const region = page.locator(`[data-testid="audio-region-${audioIdx}-0"]`);
    await expect(region).toBeVisible();
    const box = await region.boundingBox();
    const lengthTicks = await page.evaluate((idx) => {
      const regions = (window as any).__bridge.getAudioRegions(idx);
      return regions[0].lengthTicks;
    }, audioIdx);
    // PX_PER_TICK = 36 / 240 = 0.15. Allow ±1px for rounding.
    const expected = lengthTicks * (36 / 240);
    expect(box!.width).toBeGreaterThanOrEqual(expected - 1);
    expect(box!.width).toBeLessThanOrEqual(expected + 1);
  });
});
