import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M3c — audio-region drag-to-move + trim handles.
 *
 *   - Drag the region body  → updates `startTick` (and `startSample`
 *     by the same tick→sample ratio).
 *   - Drag the left handle  → trim from the start (increases
 *     `startTick` + `assetOffsetSamples`, decreases `lengthTicks`
 *     + `lengthSamples`).
 *   - Drag the right handle → trim the end (changes `lengthTicks`
 *     + `lengthSamples` only).
 *
 * All drags snap to STEP_TICKS = 240 ticks = 36px @ PX_PER_TICK=0.15.
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

async function setupRegion(page: Page): Promise<number> {
  await page.goto('/');
  await bridgeReady(page);
  await page.click('[data-testid="add-audio-track"]');
  const audioIdx = await page.evaluate(() =>
    (window as any).__project.trackCount - 1,
  );
  await importSineWav(page, audioIdx);
  await page.click(`[data-testid="track-row-${audioIdx}"]`);
  return audioIdx;
}

/// Dispatch a pointer drag against the timeline. `startSelector`
/// is where the pointerdown fires (region body, left handle, or
/// right handle); `dxPx` is the horizontal delta in CSS pixels.
async function dispatchDrag(page: Page, startSelector: string, dxPx: number) {
  await page.evaluate(({ sel, dx }) => {
    const start = document.querySelector(sel) as HTMLElement;
    const timeline = start.closest('[data-testid^="audio-timeline-"]') as HTMLElement;
    const r = start.getBoundingClientRect();
    const x0 = r.left + Math.min(r.width / 2, 3);
    const y0 = r.top + r.height / 2;
    const base = {
      bubbles: true, pointerId: 3, pointerType: 'mouse', button: 0, buttons: 1,
    };
    start.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, clientX: x0, clientY: y0,
    }));
    timeline.dispatchEvent(new PointerEvent('pointermove', {
      ...base, clientX: x0 + dx, clientY: y0,
    }));
    timeline.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: x0 + dx, clientY: y0,
    }));
  }, { sel: startSelector, dx: dxPx });
}

async function readRegion(page: Page, trackIdx: number, regionIdx: number) {
  return page.evaluate(({ t, r }) => {
    return (window as any).__bridge.getAudioRegions(t)[r];
  }, { t: trackIdx, r: regionIdx });
}

test.describe('phase-10 M3c — audio region drag + trim', () => {

  test('dragging the region body moves it by snapped tick steps', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    const before = await readRegion(page, audioIdx, 0);
    // PX_PER_TICK = 0.15. 72px = 480 ticks = 2 steps.
    await dispatchDrag(page, `[data-testid="audio-region-${audioIdx}-0"]`, 72);
    const after = await readRegion(page, audioIdx, 0);
    expect(after.startTick).toBe(before.startTick + 480);
    expect(after.lengthTicks).toBe(before.lengthTicks);
    expect(after.lengthSamples).toBe(before.lengthSamples);
  });

  test('drag snaps to STEP_TICKS — sub-step moves do nothing', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    const before = await readRegion(page, audioIdx, 0);
    // 10px = 67 ticks < half a step → snaps to 0.
    await dispatchDrag(page, `[data-testid="audio-region-${audioIdx}-0"]`, 10);
    const after = await readRegion(page, audioIdx, 0);
    expect(after.startTick).toBe(before.startTick);
  });

  test('right-handle drag extends lengthTicks + lengthSamples', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    const before = await readRegion(page, audioIdx, 0);
    // 72px right = +480 ticks.
    await dispatchDrag(page, `[data-testid="audio-region-${audioIdx}-0-trim-r"]`, 72);
    const after = await readRegion(page, audioIdx, 0);
    expect(after.lengthTicks).toBe(before.lengthTicks + 480);
    expect(after.startTick).toBe(before.startTick);
    // samplesPerTick was preserved; lengthSamples grows by the same ratio.
    const sPerT = before.lengthSamples / before.lengthTicks;
    expect(Math.abs(after.lengthSamples - (before.lengthSamples + 480 * sPerT))).toBeLessThan(2);
  });

  test('right-handle drag inward shrinks the region (clamped to >= 1 step)', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    const before = await readRegion(page, audioIdx, 0);
    // Big negative dx — should clamp to a 1-step minimum length.
    await dispatchDrag(
      page, `[data-testid="audio-region-${audioIdx}-0-trim-r"]`, -9_999,
    );
    const after = await readRegion(page, audioIdx, 0);
    expect(after.lengthTicks).toBe(240); // STEP_TICKS
    // Sample length also stays positive.
    expect(after.lengthSamples).toBeGreaterThan(0);
    // Start untouched by a right-side trim.
    expect(after.startTick).toBe(before.startTick);
  });

  test('left-handle drag inward shrinks from the start + bumps assetOffset', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    const before = await readRegion(page, audioIdx, 0);
    // 72px right on the left handle = +2 steps trim.
    await dispatchDrag(page, `[data-testid="audio-region-${audioIdx}-0-trim-l"]`, 72);
    const after = await readRegion(page, audioIdx, 0);
    expect(after.startTick).toBe(before.startTick + 480);
    expect(after.lengthTicks).toBe(before.lengthTicks - 480);
    const sPerT = before.lengthSamples / before.lengthTicks;
    const expectedOffsetDelta = Math.round(480 * sPerT);
    expect(Math.abs(after.assetOffsetSamples - (before.assetOffsetSamples + expectedOffsetDelta))).toBeLessThan(2);
    expect(Math.abs(after.lengthSamples - (before.lengthSamples - expectedOffsetDelta))).toBeLessThan(2);
  });

  test('body drag never overshoots into negative startTick', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    await dispatchDrag(page, `[data-testid="audio-region-${audioIdx}-0"]`, -9_999);
    const after = await readRegion(page, audioIdx, 0);
    expect(after.startTick).toBe(0);
  });
});
