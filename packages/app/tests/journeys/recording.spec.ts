import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/recording.md.
 *
 * Live MIDI + live audio both require user gestures + browser
 * permissions (controller, mic) that Playwright can't fully drive.
 * Cover the documented surfaces: Record button reachable, arming an
 * Audio track, and the test-only `recordPcmIntoTrack` backdoor that
 * mirrors the post-stop commit path from the docs.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / recording — MIDI + audio capture paths', () => {

  // "Hit Record in the top bar — the dot pulses red."
  test('Record button is reachable + toggles the recording state', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const record = page.getByTestId('record');
    await expect(record).toBeVisible();
    await expect(record).toContainText(/\bRecord\b/);
    // Need an armed track for Record to actually capture; arm track 0.
    await page.getByTestId('track-arm-0').click();
    await record.click();
    await expect(record).toContainText(/recording/i);
    await record.click(); // commit
    await expect(record).toContainText(/\bRecord\b/);
  });

  // "Arm an Audio track and hit Record. getUserMedia captures from
  //  the default input device into the OPFS asset store."
  test('Audio track arm + record path is wired (via the test-only PCM hook)', async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-audio-track"]');
    const audioIdx = await page.evaluate(() =>
      (window as any).__bridge.inspectTracks().length - 1,
    );

    // Generate a small PCM block + post it through the test-only
    // backdoor that mirrors what the live `getUserMedia → MediaRecorder
    // → asset commit` path produces. After it lands a region appears.
    await page.evaluate(async (idx) => {
      const pcm = new Float32Array(48_000); // 1 sec
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * 0.05) * 0.3;
      await (window as any).__bridge.recordPcmIntoTrack(idx, pcm, 48_000);
    }, audioIdx);
    await expect.poll(() => page.evaluate(
      (i) => (window as any).__bridge.getAudioRegions(i).length,
      audioIdx,
    )).toBe(1);
  });
});
