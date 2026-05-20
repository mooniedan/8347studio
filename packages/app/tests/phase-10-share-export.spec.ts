import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 10 M7a — Share & Export modal shell + Share-live tab.
 *
 * The ⤴ Share button now opens a three-tab modal. M7a ships the
 * shell + the Share-live tab (wrapping the Phase-9 collab session);
 * the Export / Render tabs land in M7b / M7d and render disabled.
 *
 * Starting a session sets `activeRoomId` synchronously, so the
 * in-session UI is testable without a live sync server (the socket
 * never connects, but the room URL + self row render immediately).
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
  // Clipboard may be unavailable / blocked in headless; stub it so
  // copy + share never reject in a way the test can't observe.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
}

test.describe('phase-10 M7a — Share & Export modal', () => {

  test('share button opens the modal on the Share-live tab; × closes it', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.locator('[data-testid="share-export-modal"]')).toHaveCount(0);
    await page.click('[data-testid="share-button"]');
    await expect(page.locator('[data-testid="share-export-modal"]')).toBeVisible();
    // Share tab is the active one.
    await expect(page.locator('[data-testid="share-tab-share"]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('[data-testid="share-export-close"]');
    await expect(page.locator('[data-testid="share-export-modal"]')).toHaveCount(0);
  });

  test('Escape and backdrop close the modal', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="share-button"]');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="share-export-modal"]')).toHaveCount(0);

    await page.click('[data-testid="share-button"]');
    // Click inside the body — stays open.
    await page.click('[data-testid="share-export-body"]');
    await expect(page.locator('[data-testid="share-export-modal"]')).toBeVisible();
    // Click the backdrop corner — closes.
    await page.locator('[data-testid="share-export-backdrop"]').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid="share-export-modal"]')).toHaveCount(0);
  });

  test('render tab is disabled until M7d lands; export is enabled', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="share-button"]');
    await expect(page.locator('[data-testid="share-tab-export"]')).toBeEnabled();
    await expect(page.locator('[data-testid="share-tab-render"]')).toBeDisabled();
  });

  test('not-in-session shows the empty state and a Start session action', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="share-button"]');
    await expect(page.locator('[data-testid="share-not-in-session"]')).toBeVisible();
    await expect(page.locator('[data-testid="share-start-session"]')).toBeVisible();
    await expect(page.locator('[data-testid="share-room-url"]')).toHaveCount(0);
  });

  test('starting a session reveals the room URL + self row; ending returns to empty', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="share-button"]');
    await page.click('[data-testid="share-start-session"]');

    // Room URL + self collaborator row appear.
    const url = page.locator('[data-testid="share-room-url"]');
    await expect(url).toBeVisible();
    await expect(url).toContainText('room=');
    await expect(page.locator('[data-testid="share-collab-self"]')).toBeVisible();
    await expect(page.locator('[data-testid="share-end-session"]')).toBeVisible();

    // End the session → back to the empty state.
    await page.click('[data-testid="share-end-session"]');
    await expect(page.locator('[data-testid="share-not-in-session"]')).toBeVisible();
    await expect(page.locator('[data-testid="share-room-url"]')).toHaveCount(0);
  });

  test('copy link gives copied feedback', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="share-button"]');
    await page.click('[data-testid="share-start-session"]');
    const copy = page.locator('[data-testid="share-copy-link"]');
    await expect(copy).toContainText('Copy');
    await copy.click();
    await expect(copy).toContainText('Copied');
  });
});
