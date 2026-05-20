import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M7c — import a bundle as a new project.
 *
 * Round-trips through the real UI: build a recognizable project,
 * export it via the Share & Export modal, then import the captured
 * zip from the Projects menu and assert a fresh project is created
 * and switched to with the same content.
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

test.describe('phase-10 M7c — Import bundle', () => {

  test('round-trips a project: export, then import as a new project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // 1. A recognizable project: a synth track + an audio track w/ asset.
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() => (window as any).__project.trackCount - 1);
    await importSineWav(page, audioIdx);
    const originalTracks = await page.evaluate(() => (window as any).__project.trackCount);
    const originalRegions = await page.evaluate(
      (i) => (window as any).__bridge.getAudioRegions(i).length,
      audioIdx,
    );
    expect(originalRegions).toBeGreaterThanOrEqual(1);

    // 2. Export it as roundtrip-song.8347.zip.
    await page.click('[data-testid="share-button"]');
    await page.click('[data-testid="share-tab-export"]');
    await page.fill('[data-testid="share-export-filename"]', 'roundtrip-song');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-testid="share-export-run"]'),
    ]);
    const zipPath = await download.path();
    await page.click('[data-testid="share-export-close"]');

    // 3. Import the bundle from the Projects menu.
    await page.click('[data-testid="projects-menu"]');
    await page.setInputFiles('[data-testid="projects-import-input"]', zipPath);

    // 4. A new project named after the bundle becomes active, carrying
    //    the same tracks + asset.
    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('roundtrip-song');
    await expect
      .poll(() => page.evaluate(() => (window as any).__project.trackCount))
      .toBe(originalTracks);
    await expect
      .poll(() => page.evaluate(
        (i) => (window as any).__bridge.getAudioRegions(i).length,
        audioIdx,
      ))
      .toBeGreaterThanOrEqual(1);
  });

  test('import button + hidden file input are present in the menu', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    await expect(page.locator('[data-testid="projects-import"]')).toBeVisible();
    await expect(page.locator('[data-testid="projects-import-input"]')).toHaveCount(1);
  });
});
