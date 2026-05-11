import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 7 M2 — app frame. Verifies the P1 grid layout (top transport
 * bar / left rail / main canvas / right inspector / bottom mixer
 * drawer), its collapse/expand controls, persistence across reload,
 * and keyboard shortcuts.
 */

async function gotoFresh(page: Page) {
  // Visit once to pin the origin so localStorage is writable, then
  // wipe any leftover layout prefs from previous tests so the
  // default state is known, and reload into the fresh state.
  await page.goto('/');
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('8347.layout.')) localStorage.removeItem(k);
    }
  });
  await page.reload();
}

test.describe('phase-7 M2 — app frame', () => {

  test('top transport bar is 48px tall and spans the width', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.getByTestId('app-frame')).toBeVisible();
    const bar = page.getByTestId('top-bar');
    await expect(bar).toBeVisible();
    const height = await bar.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(height).toBe(48);
  });

  test('all five grid regions render', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.getByTestId('top-bar')).toBeVisible();
    await expect(page.getByTestId('rail')).toBeVisible();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('mixer-drawer')).toBeVisible();
  });

  test('collaborator-avatar slot is present (Phase 9 M4 populates it)', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.getByTestId('collab-avatars')).toBeAttached();
  });

  test('right inspector collapses and expands via header buttons', async ({ page }) => {
    await gotoFresh(page);
    const inspector = page.getByTestId('inspector');
    const body = page.getByTestId('inspector-body');

    await expect(body).toBeVisible();

    // Collapse.
    await page.getByTestId('inspector-collapse').click();
    await expect(body).toBeHidden();
    await expect(page.getByTestId('inspector-expand')).toBeVisible();
    const collapsedW = await inspector.evaluate((el) =>
      Math.round(el.getBoundingClientRect().width),
    );
    expect(collapsedW).toBeLessThanOrEqual(28);

    // Restore.
    await page.getByTestId('inspector-expand').click();
    await expect(body).toBeVisible();
    const expandedW = await inspector.evaluate((el) =>
      Math.round(el.getBoundingClientRect().width),
    );
    expect(expandedW).toBeGreaterThanOrEqual(200);
  });

  test('bottom mixer drawer toggles between expanded and collapsed', async ({ page }) => {
    await gotoFresh(page);
    const drawer = page.getByTestId('mixer-drawer');
    const body = page.getByTestId('drawer-body');

    // Default expanded — body visible.
    await expect(body).toBeVisible();
    const expandedH = await drawer.evaluate((el) =>
      Math.round(el.getBoundingClientRect().height),
    );
    expect(expandedH).toBeGreaterThan(100);

    // Collapse.
    await page.getByTestId('drawer-toggle').click();
    await expect(body).toBeHidden();
    const collapsedH = await drawer.evaluate((el) =>
      Math.round(el.getBoundingClientRect().height),
    );
    expect(collapsedH).toBe(32);

    // Expand.
    await page.getByTestId('drawer-toggle').click();
    await expect(body).toBeVisible();
  });

  test('inspector collapse persists across reload', async ({ page }) => {
    await gotoFresh(page);
    await page.getByTestId('inspector-collapse').click();
    await expect(page.getByTestId('inspector-expand')).toBeVisible();

    await page.reload();
    // After reload, the collapsed-state expand button is the one rendered.
    await expect(page.getByTestId('inspector-expand')).toBeVisible();
    await expect(page.getByTestId('inspector-body')).toBeHidden();
  });

  test('drawer collapse persists across reload', async ({ page }) => {
    await gotoFresh(page);
    await page.getByTestId('drawer-toggle').click(); // expanded → collapsed
    await expect(page.getByTestId('drawer-body')).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('drawer-body')).toBeHidden();
  });

  test('Cmd/Ctrl+\\ toggles the inspector', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.getByTestId('inspector-body')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+\\');
    await expect(page.getByTestId('inspector-body')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+\\');
    await expect(page.getByTestId('inspector-body')).toBeVisible();
  });

  test('Cmd/Ctrl+M toggles the mixer drawer', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.getByTestId('drawer-body')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+m');
    await expect(page.getByTestId('drawer-body')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+m');
    await expect(page.getByTestId('drawer-body')).toBeVisible();
  });

  test('Add-track buttons remain reachable in the top bar', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.getByTestId('add-synth-track')).toBeVisible();
    await expect(page.getByTestId('add-bus-track')).toBeVisible();
    await expect(page.getByTestId('add-audio-track')).toBeVisible();
  });

  test('ProjectsMenu dropdown escapes the transport bar (not clipped)', async ({ page }) => {
    await gotoFresh(page);
    // Open the dropdown.
    await page.getByTestId('projects-menu').click();
    const list = page.getByTestId('projects-menu-list');
    await expect(list).toBeVisible();
    // The dropdown body must extend below the transport bar (48px).
    const bottom = await list.evaluate((el) =>
      Math.round(el.getBoundingClientRect().bottom),
    );
    expect(bottom).toBeGreaterThan(48);
    // And it must not be clipped by an ancestor — visibly reach the
    // demo-song row.
    await expect(page.getByTestId('projects-new-demo')).toBeVisible();
  });

  test('mixer drawer hides while the mixer popup is open', async ({ page, context }) => {
    await gotoFresh(page);
    await expect(page.getByTestId('drawer-body')).toBeVisible();
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('[data-testid="mixer-popout"]').click(),
    ]);
    // In-root drawer collapses to the "popped" status strip; the
    // mixer body is no longer in the DOM.
    await expect(page.getByTestId('mixer-drawer')).toHaveAttribute('data-popped', 'true');
    await expect(page.getByTestId('drawer-body')).toHaveCount(0);

    // Close the popup → drawer comes back.
    await popup.close();
    await expect(page.getByTestId('drawer-body')).toBeVisible({ timeout: 5_000 });
  });
});
