import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 11 M5 — version history (checkpoints).
 *
 * Save a version, diverge, then restore the saved version — restore
 * forks to a new project carrying the saved state (a reliable recovery
 * without an in-place CRDT rewind).
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function openVersionsTab(page: Page) {
  await page.click('[data-testid="share-button"]');
  await page.click('[data-testid="share-tab-versions"]');
}

test.describe('phase-11 M5 — version history', () => {

  test('save a version, diverge, then restore it as a new project', async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto('/');
    await bridgeReady(page);

    // Recognizable state to checkpoint.
    await page.click('[data-testid="add-synth-track"]');
    const savedTracks = await page.evaluate(() => (window as any).__project.trackCount);

    // Save a version of this state.
    await openVersionsTab(page);
    await expect(page.locator('[data-testid="share-versions-empty"]')).toBeVisible();
    await page.fill('[data-testid="share-version-label"]', 'v1');
    await page.click('[data-testid="share-save-version"]');
    await expect(page.locator('[data-testid="share-versions"] li')).toHaveCount(1);
    await page.click('[data-testid="share-export-close"]');

    // Diverge: add another track so current state != the saved version.
    await page.click('[data-testid="add-synth-track"]');
    await expect
      .poll(() => page.evaluate(() => (window as any).__project.trackCount))
      .toBe(savedTracks + 1);

    // Restore the saved version → new project at the saved track count.
    await openVersionsTab(page);
    await page.click('[data-testid^="share-restore-"]');
    await expect
      .poll(() => page.evaluate(() => (window as any).__project.trackCount))
      .toBe(savedTracks);
  });
});
