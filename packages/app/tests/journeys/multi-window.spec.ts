import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/multi-window.md.
 *
 * PIP and popout windows are user-gesture-gated by the browser, so
 * we can't actually open them under Playwright headless. Cover the
 * documented entry points instead — buttons reachable, fallback
 * routes wired — and rely on the phase-8 docs spec + phase-9 share
 * spec for the deeper behaviours.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / multi-window — PIP + popout + collab affordances', () => {

  // "Click ⌐ Transport in the top bar."
  test('⌐ Transport opens a PIP window where supported; button always reachable', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const btn = page.getByTestId('open-pip');
    await expect(btn).toBeVisible();
    // In Chromium with PIP enabled (our launchOption), the button is
    // not disabled. Firefox/Safari without PIP would disable it.
    const pipSupported = await page.evaluate(
      () => 'documentPictureInPicture' in window,
    );
    if (pipSupported) {
      await expect(btn).toBeEnabled();
    }
  });

  // "Click the ⤴ icon at the top of the mixer drawer."
  test('mixer popout button is wired (testid mixer-popout)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('mixer-popout')).toBeVisible();
  });

  // "This very window — the user guide — also opens … On browsers
  //  without PIP, it opens as a regular tab at `?docs=1`."
  test('?docs=1 fallback route renders the docs panel', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-panel')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('docs-content')).toBeVisible();
  });

  // "Click the ⤴ Share button in the top bar."
  test('⤴ Share button is reachable in local mode and labelled "Share"', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const btn = page.getByTestId('share-button');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(/share/i);
  });
});
