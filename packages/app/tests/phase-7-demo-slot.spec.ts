import { test, expect, type Page } from '@playwright/test';

/**
 * Demo Song slot — ephemeral by design.
 *
 * - The demo lives in a reserved in-memory slot; clicking ★ Demo
 *   Song always re-seeds fresh and never adds to the registry.
 * - The first user edit flips the banner into "Save as new project"
 *   mode; submitting forks a regular persistent project that keeps
 *   the edits while the demo stays canonical.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function openDemo(page: Page) {
  await page.click('[data-testid="projects-menu"]');
  await page.click('[data-testid="projects-new-demo"]');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__project?.projectName ?? null),
    )
    .toBe('Demo Song');
}

test.describe('Demo Song slot — ephemeral + save-as', () => {

  test('opening the demo shows the read-only banner', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await openDemo(page);

    const banner = page.getByTestId('demo-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/read-only/i);
    // Save-as button is hidden until the user edits.
    await expect(page.getByTestId('demo-save-as')).toHaveCount(0);
  });

  test('first edit flips the banner into save-as mode', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await openDemo(page);

    // Dirty the demo via a real UI mutation (add a synth track).
    await page.getByTestId('add-synth-track').click();
    await expect(page.getByTestId('demo-banner')).toContainText(/aren't saved/i);
    await expect(page.getByTestId('demo-save-as')).toBeVisible();
  });

  test('save-as forks the demo into a registered project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await openDemo(page);

    await page.getByTestId('add-synth-track').click();
    await page.getByTestId('demo-save-as').click();
    const nameInput = page.getByTestId('demo-save-name');
    await nameInput.fill('Reverb Madness');
    await page.getByTestId('demo-save-confirm').click();

    // After the fork: banner is gone, registry has the new project.
    await expect(page.getByTestId('demo-banner')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__project?.projectName ?? null),
      )
      .toBe('Demo Song'); // meta.name is still "Demo Song" — the Y.Doc
      // was captured verbatim from the seed. The forked project has a
      // separate *registry* name ('Reverb Madness'); the inner Y.Doc
      // meta still reads "Demo Song" since the user didn't rename it.

    const reg = await page.evaluate(() => {
      const raw = localStorage.getItem('8347-studio-projects');
      const r = raw ? JSON.parse(raw) : { projects: [] };
      return r.projects.map((p: { name: string }) => p.name);
    });
    expect(reg).toContain('Reverb Madness');
  });

  test('reload after save-as keeps the forked project but loses the demo', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await openDemo(page);

    await page.getByTestId('add-synth-track').click();
    await page.getByTestId('demo-save-as').click();
    await page.getByTestId('demo-save-name').fill('Persisted Beat');
    await page.getByTestId('demo-save-confirm').click();
    await expect(page.getByTestId('demo-banner')).toHaveCount(0);

    await page.reload();
    await bridgeReady(page);

    // Forked project survived.
    const projects = await page.evaluate(() => {
      const raw = localStorage.getItem('8347-studio-projects');
      const r = raw ? JSON.parse(raw) : { projects: [] };
      return r.projects.map((p: { name: string }) => p.name);
    });
    expect(projects).toContain('Persisted Beat');

    // Demo is NOT in the registry.
    expect(projects).not.toContain('Demo Song');
  });
});
