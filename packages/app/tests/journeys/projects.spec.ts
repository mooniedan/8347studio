import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/projects.md.
 *
 * The Projects menu's documented actions all do what the page
 * promises: + New project, ★ Demo Song, switch, rename, archive /
 * restore / empty trash, room-URL boot.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function projectName(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__project.projectName);
}

/// ProjectsMenu uses synchronous `window.prompt` for new-project /
/// rename and `window.confirm` for archive. Playwright's `dialog`
/// event isn't reliable here because both are synchronous from
/// JS's POV. Stub the globals directly before triggering the
/// click handler.
async function stubPrompt(page: Page, value: string) {
  await page.evaluate((v) => {
    (window as unknown as { prompt: () => string }).prompt = () => v;
  }, value);
}
async function stubConfirm(page: Page, value: boolean) {
  await page.evaluate((v) => {
    (window as unknown as { confirm: () => boolean }).confirm = () => v;
  }, value);
}

test.describe('docs / projects — menu actions', () => {

  // "Click + New project… → prompt for a name; opens a fresh project."
  test('+ New project creates and switches to a new project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // Confirm we start with the default project + one track.
    await expect.poll(() => page.evaluate(
      () => (window as any).__bridge.inspectTracks().length,
    )).toBe(1);
    await page.click('[data-testid="add-synth-track"]');
    await expect.poll(() => page.evaluate(
      () => (window as any).__bridge.inspectTracks().length,
    )).toBe(2);

    await stubPrompt(page, 'Journey Test Project');
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new"]');
    await bridgeReady(page);
    // Menu trigger reflects the registry name.
    await expect(page.getByTestId('projects-menu'))
      .toContainText('Journey Test Project', { timeout: 5_000 });
    // Fresh project = single seed track.
    await expect.poll(() => page.evaluate(
      () => (window as any).__bridge.inspectTracks().length,
    )).toBe(1);
  });

  // "★ Demo Song — open the ephemeral demo."
  test('★ Demo Song boots the demo project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect.poll(() => projectName(page)).toBe('Demo Song');
  });

  // "Archive / Restore — soft-delete into a trash drawer."
  test('archive moves a project into the trash drawer', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await stubPrompt(page, 'Soon-to-archive');
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new"]');
    await bridgeReady(page);
    await expect(page.getByTestId('projects-menu'))
      .toContainText('Soon-to-archive', { timeout: 5_000 });

    // Find the row in the menu, archive it. Project IDs are random
    // (`proj_<rand>`); the new project is the most-recently-created
    // archive button. handleArchive uses window.confirm — stub it
    // to auto-accept.
    await stubConfirm(page, true);
    await page.click('[data-testid="projects-menu"]');
    const archiveBtns = page.locator('[data-testid^="projects-archive-"]');
    await archiveBtns.last().click();
    // The menu re-opens on archive completion; click the toggle.
    await page.click('[data-testid="projects-menu"]');
    // Trash section's toggle shows the archived count.
    const trashToggle = page.getByTestId('projects-trash-toggle');
    await expect(trashToggle).toBeVisible();
    await expect(trashToggle).toContainText(/1/);
  });

  // "Opening the app with ?room=<id> boots an ephemeral project."
  test('?room=<id> URL boots a collab session (ephemeral, no IDB)', async ({ page }) => {
    await page.goto('/?room=docs-journey-test');
    await bridgeReady(page);
    // Outside-a-room the share button reads "Share"; inside, "connected"
    // (or "connecting") + a self avatar appears.
    await expect.poll(() =>
      page.getByTestId('share-button').textContent(),
    ).toMatch(/connect|disconnect/i);
    await expect(page.getByTestId('collab-self-avatar')).toBeVisible();
  });
});
