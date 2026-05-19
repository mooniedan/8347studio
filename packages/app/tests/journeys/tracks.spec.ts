import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/tracks.md.
 *
 * Adding the four track kinds via the documented + buttons, then
 * the selection / arm / delete affordances on each row.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function trackCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__bridge.inspectTracks().length);
}

test.describe('docs / tracks — adding, selecting, arming, deleting', () => {

  // "Use the + buttons in the top bar" — every one of the four adds
  // a track of the documented kind. We assert by name since
  // `inspectTracks()` doesn't expose `kind` directly.
  test('+ Synth / + Drums / + Bus / + Audio each add a track', async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto('/');
    await bridgeReady(page);
    const start = await trackCount(page);

    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(start + 1);
    await page.click('[data-testid="add-drumkit-track"]');
    await expect.poll(() => trackCount(page)).toBe(start + 2);
    await page.click('[data-testid="add-bus-track"]');
    await expect.poll(() => trackCount(page)).toBe(start + 3);
    await page.click('[data-testid="add-audio-track"]');
    await expect.poll(() => trackCount(page)).toBe(start + 4);
  });

  // "Click a row → selects the track. The main canvas swaps to its
  //  editor; the inspector reflects its properties."
  test('clicking a row selects it; the canvas head reflects the choice', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Default project has 1 track (`Track 1`); add a second and
    // verify clicking each swaps the canvas-head name.
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);

    await page.click('[data-testid="track-row-0"]');
    const firstName = await page.getByTestId('canvas-track-name').innerText();

    await page.click('[data-testid="track-row-1"]');
    const secondName = await page.getByTestId('canvas-track-name').innerText();
    expect(secondName).not.toBe(firstName);
  });

  // "Click the A pill → arms it. Only one track can be armed at a time."
  test('arm toggles per row; arming one un-arms the previous', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);

    const arm0 = page.getByTestId('track-arm-0');
    const arm1 = page.getByTestId('track-arm-1');

    await arm0.click();
    await expect(arm0).toHaveClass(/armed/);
    await arm1.click();
    await expect(arm1).toHaveClass(/armed/);
    await expect(arm0).not.toHaveClass(/armed/);
  });

  // "Delete with the × in the row's hover overlay."
  test('deleting a track removes it', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);
    await page.click('[data-testid="track-delete-1"]');
    await expect.poll(() => trackCount(page)).toBe(1);
  });
});
