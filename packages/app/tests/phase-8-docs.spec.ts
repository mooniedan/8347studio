import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 follow-up — user-guide rendering.
 *
 * `?` button in the top bar opens the guide. Chromium gets a
 * Document PIP popup; non-PIP browsers (and the test runner) get a
 * `?docs=1` new tab. The guide is a multi-page renderer driven by
 * `docs/index.json` — left nav lists pages, main area shows the
 * current page. Clicking a nav link must NOT navigate the window
 * (otherwise a PIP window would close).
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('phase-8 follow-up — user guide', () => {

  test('top-bar exposes the ? docs button', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const btn = page.getByTestId('open-docs');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAccessibleName(/user guide/i);
  });

  test('PIP button uses an explanatory label (not just "PIP")', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const btn = page.getByTestId('open-pip');
    await expect(btn).toBeVisible();
    // The label should mention "Transport" so a first-time user
    // understands what pops out.
    await expect(btn).toContainText(/transport/i);
  });

  test('?docs=1 renders the left nav and the first page', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-panel')).toBeVisible();
    // The index manifest's first entry is "overview".
    await expect(page.getByTestId('docs-nav-overview')).toBeVisible();
    await expect(page.getByTestId('docs-nav-overview')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('docs-content')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('docs-content')).toHaveAttribute(
      'data-page',
      'overview',
    );
  });

  test('clicking a nav link switches pages without navigating the window', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-content')).toBeVisible({ timeout: 5_000 });

    const urlBefore = page.url();
    await page.getByTestId('docs-nav-plugins').click();

    // Page content swapped to the plugins page.
    await expect.poll(() =>
      page.getByTestId('docs-content').getAttribute('data-page')
    ).toBe('plugins');

    // Active marker moved to plugins.
    await expect(page.getByTestId('docs-nav-plugins')).toHaveAttribute(
      'aria-current',
      'page',
    );

    // And critically — the URL did NOT change (no #page:plugins
    // appended that would break Document-PIP windows).
    expect(page.url()).toBe(urlBefore);
  });

  test('intra-page cross-links (#page:slug) switch pages', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-content')).toBeVisible({ timeout: 5_000 });

    // The overview page links to quick-start, transport, plugins
    // and troubleshooting via `#page:` URLs.
    const link = page.locator('article.prose a[href="#page:quick-start"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect.poll(() =>
      page.getByTestId('docs-content').getAttribute('data-page')
    ).toBe('quick-start');
  });
});
