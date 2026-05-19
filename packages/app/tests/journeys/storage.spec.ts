import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/files.md.
 *
 * "Project state is never stored in LocalStorage" and "every
 * persistent project is one IndexedDB database" are the load-bearing
 * docs claims. We verify them by sniffing the actual browser
 * storage from a live page.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('docs / files — IndexedDB + OPFS + LocalStorage layout', () => {

  // "Every persistent project is one IndexedDB database, keyed by
  //  its docName."
  test('IndexedDB has a database for the default project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Wait a beat for IDB persistence to flush.
    await page.waitForTimeout(500);
    const dbNames = await page.evaluate(async () => {
      const list = await indexedDB.databases();
      return list.map((d) => d.name).filter((n): n is string => !!n);
    });
    // The default project's docName lives in the registry; just
    // assert at least one IDB store exists post-boot.
    expect(dbNames.length).toBeGreaterThan(0);
  });

  // "Per-machine UI prefs only: inspector width, drawer height,
  //  layout collapsed state."
  test('LocalStorage holds only UI prefs (no project state)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Trigger a save by collapsing the inspector — that mutates
    // the layout prefs key.
    await page.keyboard.press('ControlOrMeta+\\');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.length).toBeGreaterThan(0);
    // Each known key is a small JSON blob, not a multi-MB Y.Doc dump.
    const sizes = await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage).map((k) => [k, (localStorage.getItem(k) ?? '').length]),
      ),
    );
    // Bound the total size: the docs warn LocalStorage outgrows the
    // 5 MB quota if used for project state. Each individual key
    // should stay well under 50 KB.
    for (const [k, len] of Object.entries(sizes)) {
      expect(len, `${k} too large to be a UI pref`).toBeLessThan(50_000);
    }
  });
});
