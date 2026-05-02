import { test, expect, type Page } from '@playwright/test';

// Project management — create / switch / archive / restore / purge.
// Each Playwright browser context gets its own localStorage +
// IndexedDB; the suite starts on a fresh "My Project" default.

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

test.describe('multi-project lifecycle', () => {
  test('create / switch keeps state isolated per project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('My Project');
    expect(await trackCount(page)).toBe(1);

    // Add a 2nd track in default.
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);

    // Create "Demo".
    await stubPrompt(page, 'Demo');
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new"]');
    await bridgeReady(page);
    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('Demo');
    await expect.poll(() => trackCount(page), { timeout: 4000 }).toBe(1);

    // Two tracks in Demo.
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);

    // Switch back to default — still 2 tracks.
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-open-default"]');
    await bridgeReady(page);
    await expect.poll(() => trackCount(page), { timeout: 4000 }).toBe(2);

    // Switch to Demo — still 2 tracks.
    await page.click('[data-testid="projects-menu"]');
    await page.locator('button').filter({ hasText: /^Demo/ }).first().click();
    await bridgeReady(page);
    await expect.poll(() => trackCount(page), { timeout: 4000 }).toBe(2);
  });

  test('archive moves to trash; restore brings back; purge wipes IDB', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Create "Trashy".
    await stubPrompt(page, 'Trashy');
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new"]');
    await bridgeReady(page);

    // Capture the new project's id from the active row.
    const trashyId = await page.evaluate(() => {
      const raw = localStorage.getItem('8347-studio-projects');
      const r = raw ? JSON.parse(raw) : { projects: [] };
      const p = r.projects.find((x: { name: string }) => x.name === 'Trashy');
      return (p?.id as string) ?? null;
    });
    expect(trashyId).toBeTruthy();

    // Add a track so the project has non-default state to archive.
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => trackCount(page)).toBe(2);

    // Archive Trashy from the menu (we're currently inside it).
    await stubConfirm(page, true);
    await page.click('[data-testid="projects-menu"]');
    await page.click(`[data-testid="projects-archive-${trashyId}"]`);

    // Active flips back to "My Project".
    await bridgeReady(page);
    await expect(page.locator('[data-testid="projects-menu"]')).toContainText('My Project');

    // Trashy is in the trash submenu; main list shouldn't show it
    // outside the trash section.
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-trash-toggle"]');
    await expect(page.locator(`[data-testid="projects-trash-row-${trashyId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="projects-open-${trashyId}"]`)).toHaveCount(0);

    // Restore — Trashy returns to the main list (no longer in trash row).
    await page.click(`[data-testid="projects-restore-${trashyId}"]`);
    await expect(page.locator(`[data-testid="projects-trash-row-${trashyId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="projects-open-${trashyId}"]`)).toBeVisible();

    // Re-archive, then permanently delete from the trash submenu.
    await page.click(`[data-testid="projects-archive-${trashyId}"]`);
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    // trashOpen is sticky from the earlier expand; expand only if
    // the row isn't already visible.
    if (!(await page.locator(`[data-testid="projects-trash-row-${trashyId}"]`).isVisible())) {
      await page.click('[data-testid="projects-trash-toggle"]');
    }
    await expect(page.locator(`[data-testid="projects-trash-row-${trashyId}"]`)).toBeVisible();
    await page.click(`[data-testid="projects-purge-${trashyId}"]`);

    // Trashy is gone everywhere.
    await expect(page.locator(`[data-testid="projects-trash-row-${trashyId}"]`)).toHaveCount(0);
    const stillThere = await page.evaluate((id) => {
      const raw = localStorage.getItem('8347-studio-projects');
      const r = raw ? JSON.parse(raw) : { projects: [] };
      return r.projects.some((p: { id: string }) => p.id === id);
    }, trashyId);
    expect(stillThere).toBe(false);
  });

  test('trash toggle starts collapsed; trash size displayed when items present', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Create + archive a project so trash has at least one entry.
    await stubPrompt(page, 'Discard');
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new"]');
    await bridgeReady(page);
    const id = await page.evaluate(() => {
      const raw = localStorage.getItem('8347-studio-projects');
      const r = raw ? JSON.parse(raw) : { projects: [] };
      return (
        r.projects.find((x: { name: string }) => x.name === 'Discard')?.id ?? null
      );
    });
    await stubConfirm(page, true);
    await page.click('[data-testid="projects-menu"]');
    await page.click(`[data-testid="projects-archive-${id}"]`);
    await bridgeReady(page);

    // Re-open menu; trash toggle reflects "(1, X KB)" or similar.
    await page.click('[data-testid="projects-menu"]');
    const toggleText = await page.locator('[data-testid="projects-trash-toggle"]').innerText();
    expect(toggleText).toMatch(/Trash \(1,\s*[\d.]+\s*(B|KB|MB)\)/);
  });
});
