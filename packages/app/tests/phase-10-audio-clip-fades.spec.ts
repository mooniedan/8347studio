import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M3b — audio-clip fade-in / fade-out corner overlays.
 *
 * Each region renders an optional `.fade-in` / `.fade-out` triangle
 * masking the leading / trailing edge of the waveform. Width is
 * proportional to `fadeInSamples / lengthSamples` (or fade-out
 * equivalent) times the region's pixel width.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function importSineWav(page: Page, trackIdx: number) {
  await page.evaluate(async (idx) => {
    const sr = 48_000;
    const frames = Math.round(0.5 * sr);
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
      dv.setInt16(p + i * 2, Math.round(Math.sin((2 * Math.PI * 1000 * i) / sr) * 0.5 * 0x7fff), true);
    }
    await (window as any).__bridge.importAssetIntoTrack(idx, new Uint8Array(ab), 'sine1k.wav');
  }, trackIdx);
}

async function regionLengthSamples(page: Page, trackIdx: number, regionIdx: number) {
  return page.evaluate(({ t, r }) => {
    const regions = (window as any).__bridge.getAudioRegions(t);
    return regions[r].lengthSamples as number;
  }, { t: trackIdx, r: regionIdx });
}

test.describe('phase-10 M3b — audio-clip fade overlays', () => {

  test('no fade overlays render when fade samples = 0', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__project.trackCount - 1,
    );
    await importSineWav(page, audioIdx);
    await page.click(`[data-testid="track-row-${audioIdx}"]`);
    await expect(
      page.locator(`[data-testid="audio-region-${audioIdx}-0-fade-in"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="audio-region-${audioIdx}-0-fade-out"]`),
    ).toHaveCount(0);
  });

  test('setting fadeInSamples renders a fade-in overlay sized proportionally', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__project.trackCount - 1,
    );
    await importSineWav(page, audioIdx);
    await page.click(`[data-testid="track-row-${audioIdx}"]`);

    const lengthSamples = await regionLengthSamples(page, audioIdx, 0);
    // 25% fade-in.
    const fadeInSamples = Math.floor(lengthSamples * 0.25);
    await page.evaluate(({ t, r, s }) => {
      (window as any).__bridge.setAudioRegionFade(t, r, 'in', s);
    }, { t: audioIdx, r: 0, s: fadeInSamples });

    const region = page.locator(`[data-testid="audio-region-${audioIdx}-0"]`);
    const fade = page.locator(`[data-testid="audio-region-${audioIdx}-0-fade-in"]`);
    await expect(fade).toBeVisible();
    const regionBox = await region.boundingBox();
    const fadeBox = await fade.boundingBox();
    expect(regionBox).not.toBeNull();
    expect(fadeBox).not.toBeNull();
    // Expected width ≈ 25% of region width; tolerate 2px rounding.
    const expected = regionBox!.width * 0.25;
    expect(Math.abs(fadeBox!.width - expected)).toBeLessThanOrEqual(2);
    // And anchored at the left edge of the region.
    expect(Math.abs(fadeBox!.x - regionBox!.x)).toBeLessThanOrEqual(1);
  });

  test('setting fadeOutSamples renders a fade-out overlay anchored right', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__project.trackCount - 1,
    );
    await importSineWav(page, audioIdx);
    await page.click(`[data-testid="track-row-${audioIdx}"]`);

    const lengthSamples = await regionLengthSamples(page, audioIdx, 0);
    const fadeOutSamples = Math.floor(lengthSamples * 0.4);
    await page.evaluate(({ t, r, s }) => {
      (window as any).__bridge.setAudioRegionFade(t, r, 'out', s);
    }, { t: audioIdx, r: 0, s: fadeOutSamples });

    const region = page.locator(`[data-testid="audio-region-${audioIdx}-0"]`);
    const fade = page.locator(`[data-testid="audio-region-${audioIdx}-0-fade-out"]`);
    await expect(fade).toBeVisible();
    const regionBox = await region.boundingBox();
    const fadeBox = await fade.boundingBox();
    const expected = regionBox!.width * 0.4;
    expect(Math.abs(fadeBox!.width - expected)).toBeLessThanOrEqual(2);
    // Right edge of fade-out aligns with right edge of region.
    const fadeRight = fadeBox!.x + fadeBox!.width;
    const regionRight = regionBox!.x + regionBox!.width;
    expect(Math.abs(fadeRight - regionRight)).toBeLessThanOrEqual(2);
  });

  test('fade samples clamp at the region length (no overrun)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__project.trackCount - 1,
    );
    await importSineWav(page, audioIdx);
    await page.click(`[data-testid="track-row-${audioIdx}"]`);

    const lengthSamples = await regionLengthSamples(page, audioIdx, 0);
    // Try to set 10× the region length — should clamp to lengthSamples.
    await page.evaluate(({ t, r, s }) => {
      (window as any).__bridge.setAudioRegionFade(t, r, 'in', s);
    }, { t: audioIdx, r: 0, s: lengthSamples * 10 });
    const stored = await page.evaluate(({ t }) =>
      (window as any).__bridge.getAudioRegions(t)[0].fadeInSamples,
    { t: audioIdx });
    expect(stored).toBe(lengthSamples);
  });
});
