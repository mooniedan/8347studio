import { test, expect } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/overview.md.
 *
 * The overview page is mostly prose, but it's also the landing page
 * for the in-app guide. The testable claims:
 *   - It renders when you open the user-guide PIP / ?docs=1 route.
 *   - The "Where to go next" cross-page links are intercepted (no
 *     window navigation) and switch the active page.
 */

test.describe('docs / overview — guide entry point + cross-page links', () => {

  test('overview is the first page when the guide opens', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-panel')).toBeVisible();
    await expect(page.getByTestId('docs-content')).toBeVisible({ timeout: 5_000 });
    // index.json lists overview first; the nav link reflects active state.
    await expect(page.getByTestId('docs-nav-overview')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('docs-content')).toHaveAttribute('data-page', 'overview');
  });

  // "Quick start … Transport bar … Plugins … Multi-window … Troubleshooting."
  test('"Where to go next" cross-page links route via in-page nav (no URL change)', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-content')).toBeVisible({ timeout: 5_000 });
    const before = page.url();
    // Click the quick-start cross-page link inside the article body.
    await page.locator('article.prose a[href="#page:quick-start"]').click();
    await expect.poll(() =>
      page.getByTestId('docs-content').getAttribute('data-page'),
    ).toBe('quick-start');
    // URL stays unchanged — critical for the Document-PIP window
    // which would otherwise navigate-and-close.
    expect(page.url()).toBe(before);
  });
});
