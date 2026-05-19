import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M5 — recording state visuals.
 *
 * The audio recording flow now surfaces three new affordances:
 *   - armed-not-recording → warm glow on the track row + an
 *     "ARMED" pill on the audio strip;
 *   - recording → red section border + striped growing placeholder
 *     in the timeline + "● REC from <device>" header;
 *   - input source label appears next to the record button while
 *     the take is in progress.
 *
 * Live recording needs hardware permission, so the take state is
 * flipped via the `__bridge.setMockRecording` test hook; production
 * code drives it from the real `AudioRecorder`.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function setupAudioTrack(page: Page): Promise<number> {
  await page.goto('/');
  await bridgeReady(page);
  await page.click('[data-testid="add-audio-track"]');
  const audioIdx = await page.evaluate(() =>
    (window as any).__project.trackCount - 1,
  );
  await page.click(`[data-testid="track-row-${audioIdx}"]`);
  return audioIdx;
}

test.describe('phase-10 M5 — recording state visuals', () => {

  test('arming the audio track adds the warm glow + "ARMED" pill', async ({ page }) => {
    const audioIdx = await setupAudioTrack(page);
    // Initially no arm.
    await expect(page.locator(`[data-testid="track-row-${audioIdx}"]`))
      .not.toHaveClass(/armed/);
    // Click the arm dot.
    await page.click(`[data-testid="track-arm-${audioIdx}"]`);
    await expect(page.locator(`[data-testid="track-row-${audioIdx}"]`))
      .toHaveClass(/armed/);
    // Audio track section reflects the armed state too.
    await expect(page.locator(`[data-testid="audio-track-${audioIdx}"]`))
      .toHaveClass(/armed/);
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-armed-pill"]`),
    ).toBeVisible();
  });

  test('mock-recording renders the striped placeholder + input label', async ({ page }) => {
    const audioIdx = await setupAudioTrack(page);
    await page.evaluate(({ t }) => {
      (window as any).__bridge.setMockRecording(t, 'Test Mic', Date.now() - 200);
    }, { t: audioIdx });
    await expect(page.locator(`[data-testid="audio-track-${audioIdx}"]`))
      .toHaveClass(/recording/);
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-input-label"]`),
    ).toContainText('Test Mic');
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-rec-placeholder"]`),
    ).toBeVisible();
    // Record button text flips to "Stop".
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-record"]`),
    ).toContainText('Stop');
  });

  test('placeholder grows over time during recording', async ({ page }) => {
    const audioIdx = await setupAudioTrack(page);
    await page.evaluate(({ t }) => {
      (window as any).__bridge.setMockRecording(t, 'Test Mic', Date.now());
    }, { t: audioIdx });
    const ph = page.locator(`[data-testid="audio-track-${audioIdx}-rec-placeholder"]`);
    await expect(ph).toBeVisible();
    const w0 = (await ph.boundingBox())?.width ?? 0;
    await page.waitForTimeout(500);
    const w1 = (await ph.boundingBox())?.width ?? 0;
    expect(w1).toBeGreaterThan(w0);
  });

  test('stopping mock-recording clears the placeholder + state', async ({ page }) => {
    const audioIdx = await setupAudioTrack(page);
    await page.evaluate(({ t }) => {
      (window as any).__bridge.setMockRecording(t, 'Test Mic', Date.now());
    }, { t: audioIdx });
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-rec-placeholder"]`),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as any).__bridge.setMockRecording(null, null, null);
    });
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-rec-placeholder"]`),
    ).toHaveCount(0);
    await expect(page.locator(`[data-testid="audio-track-${audioIdx}"]`))
      .not.toHaveClass(/recording/);
  });

  test('armed pill disappears once recording starts', async ({ page }) => {
    const audioIdx = await setupAudioTrack(page);
    await page.click(`[data-testid="track-arm-${audioIdx}"]`);
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-armed-pill"]`),
    ).toBeVisible();
    await page.evaluate(({ t }) => {
      (window as any).__bridge.setMockRecording(t, 'Test Mic', Date.now());
    }, { t: audioIdx });
    // While recording, the armed pill yields to the input-label header.
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-armed-pill"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="audio-track-${audioIdx}-input-label"]`),
    ).toBeVisible();
  });
});
