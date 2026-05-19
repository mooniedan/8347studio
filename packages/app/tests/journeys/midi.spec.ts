import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/midi.md.
 *
 * WebMIDI is browser-permission-gated so we can't drive the full
 * "plug in a controller" flow from Playwright. Instead we assert
 * the documented entry points are reachable: Enable MIDI button,
 * MIDI chip, Learn button, and the demo's seeded CC#74 binding.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / midi — controller + Learn entry points', () => {

  // "Click Enable MIDI in the top bar."
  test('Enable MIDI button is reachable from a fresh project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // The button shows when status === 'idle' which is the default
    // until the user grants permission.
    await expect(page.getByTestId('enable-midi')).toBeVisible();
    await expect(page.getByTestId('midi-chip')).toBeVisible();
  });

  // "Click the Learn button in the top bar."
  test('Learn toggle is reachable + clicking arms learn mode', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const learn = page.getByTestId('midi-learn-toggle');
    await expect(learn).toBeVisible();
    await expect(learn).toContainText(/^learn$/i);
    await learn.click();
    await expect(learn).toContainText(/wiggle|pick|cc/i);
  });

  // "The demo song ships with CC#74 → Lead filter cutoff already bound."
  test('demo song carries the documented CC#74 → Lead filter cutoff binding', async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect.poll(() =>
      page.evaluate(() => (window as any).__project.projectName),
    ).toBe('Demo Song');
    const binding = await page.evaluate(() =>
      (window as any).__bridge.getMidiBinding(74),
    );
    expect(binding).not.toBeNull();
    expect(binding.trackIdx).toBe(0); // Lead is track 0 per the demo seed
  });
});
