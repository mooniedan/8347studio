import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M3d — audio-region inline inspector panel.
 *
 * Clicking a region (no drag) selects it; the inline panel under
 * the timeline exposes gain (slider), fade-in / fade-out (ms),
 * plus read-only start tick / length / asset offset readouts. Each
 * control writes through dedicated Y.Doc helpers so collab peers
 * pick up the edit immediately.
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

/// Click the region body without dragging — fires pointerdown +
/// pointerup at the same coordinate so commitRegionDrag detects
/// the no-movement path and flips selection on.
async function clickRegion(page: Page, trackIdx: number, regionIdx: number) {
  await page.evaluate(({ t, r }) => {
    const el = document.querySelector(
      `[data-testid="audio-region-${t}-${r}"]`,
    ) as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width / 2, 20);
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons: 1,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, clientX: x, clientY: y,
    }));
    const timeline = el.closest('[data-testid^="audio-timeline-"]') as HTMLElement;
    timeline.dispatchEvent(new PointerEvent('pointerup', {
      ...base, clientX: x, clientY: y,
    }));
  }, { t: trackIdx, r: regionIdx });
}

async function readRegion(page: Page, trackIdx: number, regionIdx: number) {
  return page.evaluate(({ t, r }) => {
    return (window as any).__bridge.getAudioRegions(t)[r];
  }, { t: trackIdx, r: regionIdx });
}

test.describe('phase-10 M3d — audio region inspector panel', () => {

  test('panel is hidden until a region is clicked', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    const panel = page.locator(`[data-testid="audio-region-inspector-${audioIdx}"]`);
    await expect(panel).toHaveCount(0);
    await clickRegion(page, audioIdx, 0);
    await expect(panel).toBeVisible();
  });

  test('close button removes the panel + selection ring', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    await clickRegion(page, audioIdx, 0);
    const panel = page.locator(`[data-testid="audio-region-inspector-${audioIdx}"]`);
    await expect(panel).toBeVisible();
    await page.click(`[data-testid="audio-region-inspector-${audioIdx}-close"]`);
    await expect(panel).toHaveCount(0);
  });

  test('gain slider writes the gain field on the Y.Doc', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    await clickRegion(page, audioIdx, 0);
    const slider = page.locator(`[data-testid="audio-region-inspector-${audioIdx}-gain"]`);
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '0.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(async () => {
      const r = await readRegion(page, audioIdx, 0);
      return r.gain;
    }).toBeCloseTo(0.5, 2);
  });

  test('fade-in (ms) input writes fadeInSamples by sample rate', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    await clickRegion(page, audioIdx, 0);
    const sr = 48_000;
    const fadeMs = 100;
    const input = page.locator(`[data-testid="audio-region-inspector-${audioIdx}-fade-in"]`);
    await input.evaluate((el: HTMLInputElement, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, fadeMs);
    await expect.poll(async () => {
      const r = await readRegion(page, audioIdx, 0);
      return r.fadeInSamples;
    }).toBe(Math.round((fadeMs / 1000) * sr));
  });

  test('fade-out clamps when the user types > region length', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    await clickRegion(page, audioIdx, 0);
    const lengthSamples = (await readRegion(page, audioIdx, 0)).lengthSamples;
    const sr = 48_000;
    const hugeMs = (lengthSamples / sr) * 1000 * 10; // 10× too big
    const input = page.locator(`[data-testid="audio-region-inspector-${audioIdx}-fade-out"]`);
    await input.evaluate((el: HTMLInputElement, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, hugeMs);
    await expect.poll(async () => {
      const r = await readRegion(page, audioIdx, 0);
      return r.fadeOutSamples;
    }).toBe(lengthSamples);
  });

  test('selecting a different region updates the panel without remounting', async ({ page }) => {
    const audioIdx = await setupRegion(page);
    // Drop a second region beyond the first.
    await page.evaluate(({ t }) => {
      const r0 = (window as any).__bridge.getAudioRegions(t)[0];
      (window as any).__bridge.addAudioRegion(t, {
        ...r0,
        startTick: r0.startTick + 1920, // 8 steps later
      });
    }, { t: audioIdx });
    // Click region 0, then 1; the panel title should track.
    await clickRegion(page, audioIdx, 0);
    const panel = page.locator(`[data-testid="audio-region-inspector-${audioIdx}"]`);
    await expect(panel).toContainText('Region 1');
    await clickRegion(page, audioIdx, 1);
    await expect(panel).toContainText('Region 2');
  });
});
