import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/plugins.md.
 *
 * Built-in instruments + effects are listed by the docs. Third-party
 * plugins flow through the + Plugin picker. We poke each surface to
 * make sure the documented affordances are present + functional.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / plugins — built-ins + the third-party picker', () => {

  // "Click + Plugin to open the picker."
  test('+ Plugin opens the picker', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="open-plugin-picker"]');
    await expect(page.getByTestId('plugin-picker')).toBeVisible();
  });

  // "Subtractive synth ... Drumkit ... two built-in instruments."
  // The + Synth + Drums buttons wire each one to a fresh track —
  // proving the built-ins are reachable from the chrome.
  test('+ Synth and + Drums add tracks bound to the built-in instruments', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="add-synth-track"]');
    await page.click('[data-testid="add-drumkit-track"]');
    await expect.poll(() =>
      page.evaluate(() => (window as any).__bridge.inspectTracks().length),
    ).toBe(3); // default 1 + 2 added
    // Inspector reads the plugin id off the selected track.
    await page.click('[data-testid="track-row-1"]');
    await expect(page.getByTestId('inspector-plugin')).toContainText(/subtractive/i);
    await page.click('[data-testid="track-row-2"]');
    await expect(page.getByTestId('inspector-plugin')).toContainText(/drumkit/i);
  });

  // "Installed tab … Each card has an Install button; once installed
  //  it switches to ✓ Installed."
  test('demo song pre-installs the bitcrusher → its card lives in the Installed tab', async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect.poll(() =>
      page.evaluate(() => (window as any).__project.projectName),
    ).toBe('Demo Song');
    // Open the picker; the bitcrusher install was injected post-seed.
    await page.click('[data-testid="open-plugin-picker"]');
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible({ timeout: 5_000 });
  });
});
