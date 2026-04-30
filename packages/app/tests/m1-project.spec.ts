import { test, expect, type Page } from '@playwright/test';

// M1 verifies project state lives in a Y.Doc, persists through y-indexeddb,
// and migrates the legacy `#s=...&bpm=...&w=...` hash format on first load.
//
// Each test runs in its own browser context so IndexedDB is isolated. The
// "persist across reload" test reuses one context across two page loads.

const LEGACY_S =
  // 16 steps × 8 hex chars = 128 chars. We light up MIDI 60 (bit 12) on
  // step 0 and step 8 — two cells in row C4. Other steps are zero.
  '00001000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00001000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000' +
  '00000000';

async function projectShape(page: Page) {
  return page.evaluate(() => {
    // The app exposes a debug handle on window for tests only.
    const w = window as unknown as {
      __project?: {
        trackCount: number;
        clipCount: number;
        firstClipKind?: string;
        firstTrackGain?: number;
      };
    };
    return w.__project;
  });
}

test.describe('phase-1 / M1 project state', () => {
  test('legacy URL hash migrates into a Y.Doc track + StepSeq clip', async ({ page }) => {
    await page.goto(`/#s=${LEGACY_S}&bpm=140&w=saw`);

    // Wait for hydration: the loading state should clear once the Y.Doc syncs.
    await expect(page.locator('.grid')).toBeVisible();

    // Two cells should be lit (steps 0 and 8 on MIDI 60).
    await expect(page.locator('.grid .cell.on')).toHaveCount(2);

    // BPM picked up from legacy hash.
    await expect(page.locator('input[type="number"]')).toHaveValue('140');

    // Hash is cleared after migration so a refresh doesn't re-migrate.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');

    // Y.Doc shape: one MIDI track, one StepSeq clip.
    const shape = await projectShape(page);
    expect(shape).toMatchObject({ trackCount: 1, clipCount: 1, firstClipKind: 'StepSeq' });
  });

  test('state persists across reload via IndexedDB', async ({ page }) => {
    // First load: seed via legacy hash.
    await page.goto(`/#s=${LEGACY_S}&bpm=132&w=square`);
    await expect(page.locator('.grid .cell.on')).toHaveCount(2);
    await expect(page.locator('input[type="number"]')).toHaveValue('132');

    // Reload — no hash. State must come back from IndexedDB.
    await page.goto('/');
    await expect(page.locator('.grid')).toBeVisible();
    await expect(page.locator('.grid .cell.on')).toHaveCount(2);
    await expect(page.locator('input[type="number"]')).toHaveValue('132');
  });
});
