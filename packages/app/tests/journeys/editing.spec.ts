import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/editing.md.
 *
 * Step-sequencer, piano-roll, and drum-row editors all do what the
 * docs say. The fine-grained tests live in phase-10-step-seq +
 * phase-8-drumkit; these journey checks confirm the surfaces are
 * reachable and the headline behaviours work.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / editing — the main canvas editors', () => {

  // "The legacy track type ships with a step-seq clip — a 16-step ×
  //  N-pitch grid. Click any cell to toggle a note on / off."
  test('step-seq grid toggles notes on click', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="track-row-0"]');
    const cell = page.locator('button.cell[aria-label="C3 step 1"]');
    await expect(cell).toBeVisible();
    await cell.click();
    await expect(cell).toHaveClass(/on/);
    await cell.click();
    await expect(cell).not.toHaveClass(/on/);
  });

  // "Velocity lane … Clear … Randomize" — these are the docs's
  // pattern-action affordances.
  test('velocity lane + Clear + Randomize buttons reachable', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="track-row-0"]');
    await expect(page.getByTestId('velocity-lane-0')).toBeVisible();
    await expect(page.getByTestId('step-clear')).toBeVisible();
    await expect(page.getByTestId('step-randomize')).toBeVisible();
  });

  // "The default for instrument tracks created via + Synth. Each row
  //  is one MIDI pitch; each column is a 1/16 step."
  test('+ Synth track shows a piano-roll grid; clicking a cell adds a note', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="track-row-1"]');
    // PianoRoll renders with testid per cell `piano-cell-<midi>-<col>`.
    const cell = page.locator(`[data-testid="piano-cell-60-0"]`);
    await expect(cell).toBeVisible();
    await cell.click();
    const notes = await page.evaluate(() =>
      (window as any).__bridge.getPianoRollNotes(1),
    );
    expect(notes.some((n: { pitch: number; startTick: number }) =>
      n.pitch === 60 && n.startTick === 0)).toBe(true);
  });

  // "Drumkit tracks render the piano-roll with 5 named rows."
  test('+ Drums track shows the GM-pitch drum-row labels', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-drumkit-track"]');
    await page.click('[data-testid="track-row-1"]');
    // Each documented row (Kick / Snare / Closed Hat / Open Hat) is
    // visible in the drum-roll key column.
    const keys = page.locator('.drum-roll .key');
    for (const name of ['Kick', 'Snare', 'Closed Hat', 'Open Hat']) {
      await expect(keys.filter({ hasText: new RegExp(`^${name}$`) })).toBeVisible();
    }
  });
});
