import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/shortcuts.md.
 *
 * The two implemented window-level shortcuts. The "(planned)" rows
 * in the docs table are explicitly opt-out — we don't test those.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / shortcuts — Cmd/Ctrl + \\ + M', () => {

  // "Cmd / Ctrl + \\ — Toggle the right inspector."
  test('Cmd/Ctrl+\\ collapses + restores the inspector', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Default state: inspector body visible.
    await expect(page.getByTestId('inspector-body')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+\\');
    await expect(page.getByTestId('inspector-body')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+\\');
    await expect(page.getByTestId('inspector-body')).toBeVisible();
  });

  // "Cmd / Ctrl + M — Toggle the bottom mixer drawer."
  test('Cmd/Ctrl+M expands / collapses the mixer drawer', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // The drawer's section carries `data-expanded`. When collapsed
    // the section is unmounted entirely and only the rail strip
    // remains — assert presence of the body content as the proxy
    // for expanded state.
    const before = await page.getByTestId('drawer-body').count();
    await page.keyboard.press('ControlOrMeta+m');
    await expect.poll(() => page.getByTestId('drawer-body').count())
      .not.toBe(before);
    await page.keyboard.press('ControlOrMeta+m');
    await expect.poll(() => page.getByTestId('drawer-body').count())
      .toBe(before);
  });
});
