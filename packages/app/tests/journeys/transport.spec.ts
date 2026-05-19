import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/transport.md.
 *
 * Walks every documented control on the top transport bar and
 * asserts it's reachable + does what the docs claim.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function currentTick(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__bridge.debugCurrentTick());
}

async function bpm(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__bridge.debugBpm());
}

test.describe('docs / transport — every control on the top bar', () => {

  // "The top bar holds the global transport." — every listed surface
  // is reachable from a fresh project boot.
  test('every documented control is present', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Left side: project menu + play button.
    await expect(page.getByTestId('projects-menu')).toBeVisible();
    await expect(page.locator('button.play')).toBeVisible();
    // Loop toggle + bar range inputs.
    await expect(page.getByTestId('loop-toggle')).toBeVisible();
    await expect(page.getByTestId('loop-start-bar')).toBeVisible();
    await expect(page.getByTestId('loop-end-bar')).toBeVisible();
    // BPM + tick readouts.
    await expect(page.getByTestId('bpm-input')).toBeVisible();
    // Master meter.
    await expect(page.getByTestId('master-meter')).toBeVisible();
    // Right side: collaborator avatars slot, ⤴ Share, ⌐ Transport,
    // and the user-guide ? button.
    await expect(page.getByTestId('collab-avatars')).toBeAttached();
    await expect(page.getByTestId('share-button')).toBeVisible();
    await expect(page.getByTestId('open-pip')).toBeVisible();
    await expect(page.getByTestId('open-docs')).toBeVisible();
  });

  // "Play / Stop — green when stopped, accent-red when playing.
  //  Stop returns the playhead to bar 1 tick 0."
  test('play advances tick; stop resets to 0', async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto('/');
    await bridgeReady(page);
    expect(await currentTick(page)).toBe(0);
    await page.click('button.play');
    await expect.poll(() => currentTick(page), { timeout: 3_000 })
      .toBeGreaterThan(0);
    await page.click('button.play');
    await expect.poll(() => currentTick(page), { timeout: 2_000 }).toBe(0);
  });

  // "New projects default to a 4-bar loop, enabled — uncheck the
  //  toggle for linear playback."
  test('loop toggle defaults to checked on a fresh project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('loop-toggle')).toBeChecked();
    // Bar inputs default to 1..4 per the docs.
    await expect(page.getByTestId('loop-start-bar')).toHaveValue('1');
    await expect(page.getByTestId('loop-end-bar')).toHaveValue('4');
  });

  // "BPM — drag the readout vertically for ±1 BPM per pixel.
  //  Double-click to type a value directly."
  test('BPM can be set by typing a value into the input', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const start = await bpm(page);
    expect(start).toBeGreaterThan(0);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="bpm-input"]') as HTMLInputElement;
      el.value = '140';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => bpm(page), { timeout: 3_000 }).toBe(140);
  });

  // "? button — opens this user guide."
  test('? button is wired to a Share-collab–style modal / fallback', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    // In a Chromium context with Document PIP available the button
    // opens a PIP window; we just assert the button is interactive
    // (the Phase-8 docs spec exercises the routing more thoroughly).
    const btn = page.getByTestId('open-docs');
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAccessibleName(/user guide/i);
  });

  // "⌐ Transport — pop the transport out into a Picture-in-Picture
  //  window." — at minimum the button exists with an explanatory
  //  label (Phase-9 follow-up changed this from a bare "PIP").
  test('⌐ Transport button advertises what it does', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const btn = page.getByTestId('open-pip');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(/transport/i);
  });

  // "⤴ Share" reads "Share" in local mode (docs/multi-window page
  //  expands on the in-room behaviour).
  test('⤴ Share starts in "Share" state when outside a room', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await expect(page.getByTestId('share-button')).toContainText(/share/i);
    // No self-avatar until a session is active.
    await expect(page.getByTestId('collab-self-avatar')).toHaveCount(0);
  });
});
