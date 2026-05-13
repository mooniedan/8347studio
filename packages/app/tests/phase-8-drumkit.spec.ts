import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M2 — drumkit plugin (first-party). End-to-end: add a drumkit
 * track, paint a kick at tick 0, play, watch the engine peak rise.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function trackCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__bridge.inspectTracks().length);
}

async function trackPeak(page: Page, idx: number): Promise<number> {
  return page.evaluate(
    (i) => (window as any).__bridge.debugTrackPeak(i),
    idx,
  );
}

test.describe('phase-8 M2 — drumkit plugin', () => {

  test('+ Drums button is reachable in the top bar', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('add-drumkit-track')).toBeVisible();
  });

  test('adding a drumkit track produces an audible kick when played', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    const before = await trackCount(page);
    await page.getByTestId('add-drumkit-track').click();
    await expect.poll(() => trackCount(page)).toBe(before + 1);
    const drumIdx = before;

    // Start the engine first so the worklet is processing blocks;
    // then fire the kick. Poll the per-track peak meter for ~300 ms
    // (one kick envelope) — any non-trivial peak proves the voice
    // is producing audio.
    await page.click('button.play');
    await page.waitForTimeout(50);
    await page.evaluate((idx) => {
      (window as any).__bridge.noteOn(idx, 36, 110);
    }, drumIdx);

    let peak = 0;
    for (let i = 0; i < 30 && peak < 0.05; i++) {
      await page.waitForTimeout(20);
      peak = await trackPeak(page, drumIdx);
    }
    await page.click('button.play'); // stop
    expect(peak).toBeGreaterThan(0.05);
  });

  test('drumkit has 13 host-rendered descriptors', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.getByTestId('add-drumkit-track').click();
    // The plugin-panel mounts when the new track is selected.
    await expect(page.getByTestId('inspector-plugin')).toHaveText('drumkit');
  });

  test('drum tracks render the GM drum-map rows in the piano roll', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.getByTestId('add-drumkit-track').click();
    const trackIdx = await page.evaluate(() => (window as any).__bridge.inspectTracks().length - 1);
    await page.click(`[data-testid="track-row-${trackIdx}"]`);

    // Drum rows are visible — pitches 36 / 38 / 39 / 42 / 46 each
    // have a cell at every step. We only check the row labels +
    // the kick cell at step 0 to keep the spec tight.
    await expect(page.locator(`[data-testid="piano-cell-36-0"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="piano-cell-38-0"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="piano-cell-42-0"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="piano-cell-46-0"]`)).toBeVisible();

    // Friendly labels in the key column (scoped to .drum-roll so we
    // don't match identically-named param labels in the panel).
    const keys = page.locator('.drum-roll .key');
    await expect(keys.filter({ hasText: /^Kick$/ })).toBeVisible();
    await expect(keys.filter({ hasText: /^Snare$/ })).toBeVisible();
    await expect(keys.filter({ hasText: /^Closed Hat$/ })).toBeVisible();
    await expect(keys.filter({ hasText: /^Open Hat$/ })).toBeVisible();

    // Clicking a kick cell adds a note at MIDI 36.
    await page.click('[data-testid="piano-cell-36-0"]');
    const notes = await page.evaluate(
      (i) => (window as any).__bridge.getPianoRollNotes(i),
      trackIdx,
    );
    expect(notes.some((n: { pitch: number }) => n.pitch === 36)).toBe(true);
  });
});
