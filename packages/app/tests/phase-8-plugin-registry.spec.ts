import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M7 — plugin registry. The picker's Browse tab fetches a
 * curated `registry.json` and renders each entry as an installable
 * card next to the paste-your-own-URL input.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('phase-8 M7 — plugin registry', () => {

  test('Browse tab loads the registry and shows the example plugins', async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto('/');
    await bridgeReady(page);

    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();

    // Registry section appears with both example plugins as cards.
    await expect(page.getByTestId('plugin-picker-registry')).toBeVisible();
    await expect(page.getByTestId('registry-card-com.example.bitcrusher')).toBeVisible();
    await expect(page.getByTestId('registry-card-com.example.gain')).toBeVisible();

    // Each card has an Install button.
    await expect(page.getByTestId('registry-install-com.example.bitcrusher')).toBeVisible();
    await expect(page.getByTestId('registry-install-com.example.gain')).toBeVisible();

    // The paste-your-own-URL form is still present below.
    await expect(page.getByTestId('plugin-url-input')).toBeVisible();
  });

  test('Installing from the registry adds the plugin and flips to Installed', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await expect(page.getByTestId('registry-card-com.example.bitcrusher')).toBeVisible();

    await page.getByTestId('registry-install-com.example.bitcrusher').click();

    // Picker flips back to Installed and shows the card.
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible();
  });

  test('Already-installed plugins show "✓ Installed" instead of an Install button', async ({ page }) => {
    test.setTimeout(20_000);
    await page.goto('/');
    await bridgeReady(page);

    await page.getByTestId('open-plugin-picker').click();
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await page.getByTestId('registry-install-com.example.bitcrusher').click();
    await expect(page.getByTestId('plugin-card-com.example.bitcrusher')).toBeVisible();

    // Back to Browse — the bitcrusher row now shows installed badge.
    await page.getByTestId('plugin-picker-tabs-browse').click();
    await expect(page.getByTestId('registry-installed-com.example.bitcrusher')).toBeVisible();
    await expect(page.getByTestId('registry-install-com.example.bitcrusher')).toHaveCount(0);
  });
});
