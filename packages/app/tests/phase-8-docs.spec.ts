import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 follow-up — user-guide rendering.
 *
 * The `?` button in the top bar opens the guide. Chromium gets a
 * Document PIP popup; non-PIP browsers (and the test runner here)
 * get a `?docs=1` new tab. We exercise the renderer directly via
 * the route, plus the toolbar button itself.
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

  test('?docs=1 renders the user guide with headings + TOC', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-panel')).toBeVisible();
    // Loading state resolves to content.
    await expect(page.getByTestId('docs-content')).toBeVisible({ timeout: 5_000 });
    // h1 + at least one h2 rendered.
    await expect(page.locator('article.prose h1').first()).toBeVisible();
    const h2Count = await page.locator('article.prose h2').count();
    expect(h2Count).toBeGreaterThan(2);
  });

  test('TOC anchors scroll to the matching heading', async ({ page }) => {
    await page.goto('/?docs=1');
    await expect(page.getByTestId('docs-content')).toBeVisible({ timeout: 5_000 });
    // Pick the first h2 and find its TOC link via id.
    const firstH2 = page.locator('article.prose h2').first();
    const id = await firstH2.getAttribute('id');
    expect(id).toBeTruthy();
    const link = page.getByTestId(`toc-${id}`);
    await expect(link).toBeVisible();
    await link.click();
    // After click, the URL fragment matches and the heading is in view.
    await expect.poll(() =>
      page.evaluate(() => window.location.hash)
    ).toBe(`#${id}`);
  });
});
