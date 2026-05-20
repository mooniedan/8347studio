import { test, expect, type Page } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';

/**
 * Phase 10 M7b — Export bundle tab.
 *
 * Exports a zip of { project.yjs, assets/<sha>.bin, manifest.json }.
 * Tests seed an audio asset (so there's something to bundle), drive
 * the Export tab, capture the download, and unzip it in-process.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

/// Build a tiny 0.5s sine WAV and import it into a track — same
/// fixture the audio-clip-inspector spec uses. Creates one OPFS
/// asset + its project metadata entry.
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

async function setupAudioProject(page: Page) {
  await page.goto('/');
  await bridgeReady(page);
  await page.click('[data-testid="add-audio-track"]');
  const idx = await page.evaluate(() => (window as any).__project.trackCount - 1);
  await importSineWav(page, idx);
}

async function openExportTab(page: Page) {
  await page.click('[data-testid="share-button"]');
  await page.click('[data-testid="share-tab-export"]');
}

async function exportZip(page: Page): Promise<Record<string, Uint8Array>> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-testid="share-export-run"]'),
  ]);
  const path = await download.path();
  return unzipSync(new Uint8Array(await readFile(path)));
}

test.describe('phase-10 M7b — Export bundle', () => {

  test('export tab is enabled and resolves a size estimate', async ({ page }) => {
    await setupAudioProject(page);
    await openExportTab(page);
    await expect(page.locator('[data-testid="share-export-filename"]')).toBeVisible();
    await expect(page.locator('[data-testid="share-export-estimate"]')).not.toHaveText('…', { timeout: 5000 });
  });

  test('exports a zip with project.yjs, manifest.json and asset bytes', async ({ page }) => {
    await setupAudioProject(page);
    await openExportTab(page);
    await page.fill('[data-testid="share-export-filename"]', 'my-song');
    const files = await exportZip(page);

    const names = Object.keys(files);
    expect(names).toContain('project.yjs');
    expect(names).toContain('manifest.json');
    const assetEntries = names.filter((f) => f.startsWith('assets/'));
    expect(assetEntries.length).toBeGreaterThanOrEqual(1);

    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest.format).toBe('8347-bundle');
    expect(manifest.includeAudio).toBe(true);
    expect(manifest.assets).toHaveLength(assetEntries.length);

    // project.yjs is a real Y update that restores the tracks.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, files['project.yjs']);
    expect(doc.getArray('tracks').length).toBeGreaterThanOrEqual(1);
    doc.destroy();
  });

  test('unchecking "include audio" drops the asset bytes', async ({ page }) => {
    await setupAudioProject(page);
    await openExportTab(page);
    await page.click('[data-testid="share-export-include-audio"]');
    const files = await exportZip(page);
    expect(Object.keys(files).filter((f) => f.startsWith('assets/'))).toHaveLength(0);
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest.includeAudio).toBe(false);
    expect(manifest.assets).toHaveLength(0);
  });

  test('filename is sanitized into the download name', async ({ page }) => {
    await setupAudioProject(page);
    await openExportTab(page);
    await page.fill('[data-testid="share-export-filename"]', 'cool track!!');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-testid="share-export-run"]'),
    ]);
    // Each run of non-[\w.-] chars collapses to a single underscore.
    expect(download.suggestedFilename()).toBe('cool_track_.8347.zip');
  });
});
