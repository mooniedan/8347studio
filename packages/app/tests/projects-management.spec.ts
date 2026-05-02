import { test, expect, type Page } from '@playwright/test';

// Project management — create / switch / delete. Each Playwright
// browser context gets its own localStorage + IndexedDB, so the
// suite starts on a fresh "My Project" default. Tests then create
// a second project, switch between them to confirm state is
// isolated per-project, and delete to confirm cleanup.

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function trackCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __project: { trackCount: number } };
    return w.__project.trackCount;
  });
}

async function stubPrompt(page: Page, value: string) {
  await page.evaluate((v) => {
    (window as unknown as { prompt: (q?: string, def?: string) => string | null }).prompt = () => v;
  }, value);
}

async function stubConfirm(page: Page, value: boolean) {
  await page.evaluate((v) => {
    (window as unknown as { confirm: (q?: string) => boolean }).confirm = () => v;
  }, value);
}

test.describe('multi-project: create, switch, delete', () => {
  test('default project loads, new project lives separately, delete cleans up', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Default project is open. ProjectsMenu trigger shows "My Project".
    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('My Project');
    expect(await trackCount(page)).toBe(1);

    // Add a track in the default so we can verify isolation later.
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);

    // Open the menu and create a new project named "Demo".
    await stubPrompt(page, 'Demo');
    await page.click('[data-testid="projects-menu"]');
    await expect(page.locator('[data-testid="projects-new"]')).toBeVisible();
    await page.click('[data-testid="projects-new"]');

    // Switch resets layout via {#key activeProjectId}; bridge takes a
    // beat to re-attach.
    await expect
      .poll(async () => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
      .toBe(true);
    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('Demo');

    // Fresh project has the seeded single step-seq track.
    await expect.poll(() => trackCount(page), { timeout: 4000 }).toBe(1);

    // Add a synth in Demo so it has 2.
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);

    // Switch back to default. State must be the 2 tracks we left there.
    await page.click('[data-testid="projects-menu"]');
    // Default project's "open" button — its id is 'default'.
    await page.click('[data-testid="projects-open-default"]');
    await bridgeReady(page);
    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('My Project');
    await expect.poll(() => trackCount(page), { timeout: 4000 }).toBe(2);

    // Switch to Demo again — its 2 tracks survived. Find its id by
    // walking the menu.
    await page.click('[data-testid="projects-menu"]');
    const demoBtn = page.locator('button').filter({ hasText: /^Demo/ }).first();
    await demoBtn.click();
    await bridgeReady(page);
    await expect.poll(() => trackCount(page), { timeout: 4000 }).toBe(2);

    // Delete Demo (active). Auto-switches back to default.
    await stubConfirm(page, true);
    await page.click('[data-testid="projects-menu"]');
    const demoDelete = page
      .locator('[data-testid^="projects-delete-"]')
      .filter({ has: page.locator(':scope') }) // any delete row
      .first();
    // The page may render multiple delete buttons (one per project).
    // Pick the one whose row's open button text starts with "Demo".
    const demoRow = page.locator('li.row').filter({ hasText: 'Demo' }).first();
    await demoRow.locator('[data-testid^="projects-delete-"]').click();

    // Active project flips back to "My Project".
    await bridgeReady(page);
    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('My Project');

    // Demo no longer in the list.
    await page.click('[data-testid="projects-menu"]');
    await expect(page.locator('[data-testid="projects-menu-list"]')).not.toContainText('Demo');
  });
});
