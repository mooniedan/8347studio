import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M6 — Settings modal (MIDI tab).
 *
 * Surfaces device list / controller-map / MIDI Learn affordances in
 * a single panel. The Phase 3 backend (`setMidiBinding` /
 * `removeMidiBinding`) does the actual wiring; this milestone is
 * purely the visual layer.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('phase-10 M6 — Settings panel', () => {

  test('gear button opens the panel; × closes it', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.locator('[data-testid="settings-panel"]')).toHaveCount(0);
    await page.click('[data-testid="open-settings"]');
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
    await page.click('[data-testid="settings-close"]');
    await expect(page.locator('[data-testid="settings-panel"]')).toHaveCount(0);
  });

  test('Escape key closes the panel', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="open-settings"]');
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-panel"]')).toHaveCount(0);
  });

  test('backdrop click closes the panel; clicks inside do not', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="open-settings"]');
    // Click on the panel body — should stay open.
    await page.click('[data-testid="settings-midi-body"]');
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
    // Click outside via the backdrop (top-left corner of the
    // backdrop sits outside the panel).
    await page.locator('[data-testid="settings-backdrop"]').click({
      position: { x: 5, y: 5 },
    });
    await expect(page.locator('[data-testid="settings-panel"]')).toHaveCount(0);
  });

  test('empty state appears when no MIDI bindings exist', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="open-settings"]');
    await expect(
      page.locator('[data-testid="settings-midi-bindings-empty"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="settings-midi-bindings"]'),
    ).toHaveCount(0);
  });

  test('seeded bindings render as rows; unbind removes them', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Add two bindings via the bridge before opening settings.
    await page.evaluate(() => {
      const b = (window as any).__bridge;
      b.setMidiBinding(74, { trackIdx: 0, paramId: 6 });
      b.setMidiBinding(11, { trackIdx: 0, paramId: 17 });
    });
    await page.click('[data-testid="open-settings"]');
    await expect(
      page.locator('[data-testid="settings-midi-binding-74"]'),
    ).toContainText('CC74');
    await expect(
      page.locator('[data-testid="settings-midi-binding-11"]'),
    ).toContainText('CC11');
    // Unbind one.
    await page.click('[data-testid="settings-midi-unbind-74"]');
    await expect(
      page.locator('[data-testid="settings-midi-binding-74"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="settings-midi-binding-11"]'),
    ).toBeVisible();
  });

  test('learn toggle flips its aria-pressed', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="open-settings"]');
    const learn = page.locator('[data-testid="settings-midi-learn-toggle"]');
    await expect(learn).toHaveAttribute('aria-pressed', 'false');
    await learn.click();
    await expect(learn).toHaveAttribute('aria-pressed', 'true');
    await learn.click();
    await expect(learn).toHaveAttribute('aria-pressed', 'false');
  });

  test('shows an MIDI device status row (no devices in headless test env)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="open-settings"]');
    // Headless Chromium never grants MIDI: status is `idle` until the
    // user clicks "Enable MIDI". The enable button stays reachable.
    await expect(
      page.locator('[data-testid="settings-enable-midi"]'),
    ).toBeVisible();
  });
});
