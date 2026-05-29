import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Phase 10 P6 — user-facing audio-clip import (drag-drop + Import…).
 *
 * Phase 5 shipped the import *infrastructure* (OPFS asset store,
 * decodeAudioData, AudioRegion model, engine playback) but never wired
 * the user-facing entry point the track hint promised. These tests
 * cover the two affordances added here:
 *   - drag a file onto an Audio track → region lands at the cursor tick
 *   - the Import… button → native picker → region appended
 * plus the non-audio rejection and the read-only-viewer guard (the
 * latter lives in phase-9-share.spec.ts where the collab fixture is).
 *
 * Grid constants mirror AudioTrackView: PX_PER_TICK = 36 / STEP_TICKS,
 * STEP_TICKS = 240. These are app-layout constants (not environment
 * constants) — the drop-position assertion is intentionally coupled to
 * them, so if the grid scale changes this test flags it.
 */
const STEP_TICKS = 240;
const PX_PER_TICK = 36 / STEP_TICKS;

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function addAudioTrack(page: Page): Promise<number> {
  await page.click('[data-testid="add-audio-track"]');
  const idx = await page.evaluate(() => (window as any).__project.trackCount - 1);
  await page.click(`[data-testid="track-row-${idx}"]`);
  return idx;
}

async function regions(page: Page, trackIdx: number) {
  return page.evaluate(
    (i) => (window as any).__bridge.getAudioRegions(i) as { startTick: number; assetHash: string }[],
    trackIdx,
  );
}

async function trackPeak(page: Page, idx: number): Promise<number> {
  return page.evaluate((i) => (window as any).__bridge.debugTrackPeak(i) as Promise<number>, idx);
}

// Seed one region via the bridge so the timeline (and its rect) exists
// before we drop a second clip at a measured cursor position.
async function importSineWav(page: Page, trackIdx: number, seconds = 0.5) {
  await page.evaluate(async ({ idx, secs }) => {
    const sr = 48_000;
    const frames = Math.round(secs * sr);
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
  }, { idx: trackIdx, secs: seconds });
}

// Dispatch a real `drop` DragEvent carrying a File at a given clientX
// on the audio-track section. Returns nothing — the import is async, so
// callers poll for the region.
async function dropFileAt(
  page: Page,
  trackIdx: number,
  clientX: number,
  file: { name: string; type: string; kind: 'wav' | 'text' },
) {
  await page.evaluate(
    async ({ idx, x, f }) => {
      let bytes: Uint8Array;
      if (f.kind === 'wav') {
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
          dv.setInt16(p + i * 2, Math.round(Math.sin((2 * Math.PI * 660 * i) / sr) * 0.5 * 0x7fff), true);
        }
        bytes = new Uint8Array(ab);
      } else {
        bytes = new TextEncoder().encode('not audio');
      }
      const file = new File([bytes], f.name, { type: f.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const section = document.querySelector(`[data-testid="audio-track-${idx}"]`)!;
      const rect = section.getBoundingClientRect();
      const init: DragEventInit = {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: x, clientY: rect.top + rect.height / 2,
      };
      section.dispatchEvent(new DragEvent('dragover', init));
      section.dispatchEvent(new DragEvent('drop', init));
    },
    { idx: trackIdx, x: clientX, f: file },
  );
}

test.describe('phase-10 P6 — audio-clip import (drag-drop + picker)', () => {

  test('dropping a WAV at the cursor places a region at that tick and plays', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const idx = await addAudioTrack(page);

    // Seed a region at tick 0 so the timeline renders + has a rect.
    await importSineWav(page, idx);
    await expect(page.locator(`[data-testid="audio-region-${idx}-0"]`)).toBeVisible();

    // Drop a second clip 8 steps (half a bar) along the timeline.
    const targetTick = 8 * STEP_TICKS; // 1920
    const timelineLeft = await page.evaluate((i) =>
      document.querySelector(`[data-testid="audio-timeline-${i}"]`)!.getBoundingClientRect().left,
      idx,
    );
    const clientX = timelineLeft + targetTick * PX_PER_TICK;
    await dropFileAt(page, idx, clientX, { name: 'drop-660.wav', type: 'audio/wav', kind: 'wav' });

    // A second region lands — at the dropped tick, NOT tick 0.
    await expect.poll(() => regions(page, idx).then((r) => r.length), { timeout: 5_000 }).toBe(2);
    const r = await regions(page, idx);
    const dropped = r.find((x) => x.startTick !== 0);
    expect(dropped, 'a region exists away from tick 0').toBeTruthy();
    expect(dropped!.startTick).toBe(targetTick);

    // End-to-end: the dropped clip actually plays.
    await page.evaluate(() => (window as any).__bridge.setTransport(true));
    await expect.poll(() => trackPeak(page, idx), { timeout: 4_000, intervals: [80, 100, 200] })
      .toBeGreaterThan(0.05);
  });

  test('the Import… button imports the picked file (real bell.wav)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const idx = await addAudioTrack(page);

    // Real on-disk sample — resolved relative to this spec so cwd
    // doesn't matter.
    const bellPath = fileURLToPath(new URL('../public/demo-assets/bell.wav', import.meta.url));
    await page.setInputFiles(`[data-testid="audio-track-${idx}-import-input"]`, bellPath);

    // A region lands. The metadata records the source filename, which is
    // only written after a successful decode — so this proves the real
    // WAV decoded through the picker path (sampleRate is the decode
    // context's rate, not the file's, since decodeAudioData resamples).
    await expect.poll(() => regions(page, idx).then((r) => r.length), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
    const decoded = await page.evaluate((i) => {
      const r = (window as any).__bridge.getAudioRegions(i)[0];
      const m = (window as any).__bridge.getAssetMetadata(r.assetHash);
      return { filename: m?.sourceFilename ?? null, frames: m?.frames ?? 0 };
    }, idx);
    expect(decoded.filename).toBe('bell.wav');
    expect(decoded.frames).toBeGreaterThan(0);
  });

  test('dropping a non-audio file is rejected with an inline error', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const idx = await addAudioTrack(page);
    await importSineWav(page, idx); // timeline present

    const before = (await regions(page, idx)).length;
    const left = await page.evaluate((i) =>
      document.querySelector(`[data-testid="audio-timeline-${i}"]`)!.getBoundingClientRect().left, idx);
    await dropFileAt(page, idx, left + 100, { name: 'notes.txt', type: 'text/plain', kind: 'text' });

    await expect(page.locator(`[data-testid="audio-track-${idx}-import-error"]`)).toBeVisible();
    // No new region was added.
    expect((await regions(page, idx)).length).toBe(before);
  });
});
