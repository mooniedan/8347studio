import { test, expect, type Page } from '@playwright/test';

/**
 * Journey spec — packages/app/public/docs/quick-start.md.
 *
 * Walks the documented "three clicks to sound" flow end-to-end and
 * the surrounding claims so the docs page acts as a live contract.
 * If any of these tests fail, the docs lie.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function trackNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as any).__bridge.inspectTracks().map((t: { name: string }) => t.name),
  );
}

async function currentTick(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__bridge.debugCurrentTick());
}

test.describe('docs / quick-start — three clicks to sound', () => {

  // Step 1: "Open the app. The default starter project carries one
  //          empty MIDI track."
  test('default project ships with a single empty MIDI track', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const names = await trackNames(page);
    expect(names).toHaveLength(1);
    // Both the projects menu + track row are reachable from the chrome.
    await expect(page.getByTestId('projects-menu')).toBeVisible();
    await expect(page.getByTestId('track-row-0')).toBeVisible();
  });

  // Steps 2 + 3: "Click ★ Demo Song" → the listed tracks all exist.
  //              "Hit Play" → the engine tick advances and audio plays.
  test('★ Demo Song loads the feature-tour project and plays end-to-end', async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    // Wait for the Demo Song's seed + enrichment to settle.
    await expect.poll(() =>
      page.evaluate(() => (window as any).__project.projectName),
    ).toBe('Demo Song');
    await expect.poll(() => trackNames(page).then((n) => n.length), {
      timeout: 8_000,
    }).toBeGreaterThanOrEqual(5);

    // Every track the docs list must actually exist.
    const names = (await trackNames(page)).map((n) => n.toLowerCase());
    for (const expected of ['lead', 'bass', 'reverb bus', 'drums', 'riser']) {
      expect(names.some((n) => n.includes(expected.split(' ')[0]))).toBe(true);
    }

    // Step 3: Play.
    expect(await currentTick(page)).toBe(0);
    await page.click('button.play');
    await expect.poll(() => currentTick(page), { timeout: 3_000 })
      .toBeGreaterThan(0);
    // Stop returns the playhead to bar 1 / tick 0 (per docs/transport).
    await page.click('button.play');
    await expect.poll(() => currentTick(page), { timeout: 2_000 }).toBe(0);
  });

  // "Every reload starts it fresh." → the demo doesn't persist as an
  // entry in the registry; reload lands on a non-demo project.
  test('demo song is ephemeral — reload drops it', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect.poll(() =>
      page.evaluate(() => (window as any).__project.projectName),
    ).toBe('Demo Song');

    await page.reload();
    await bridgeReady(page);
    const name = await page.evaluate(() => (window as any).__project.projectName);
    expect(name).not.toBe('Demo Song');
  });

  // "The moment you edit anything, a banner offers to save your
  // changes as a new persistent project."
  test('editing the demo surfaces the save-as banner', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect.poll(() =>
      page.evaluate(() => (window as any).__project.projectName),
    ).toBe('Demo Song');
    // Demo banner exists in scratch mode; on first edit it flips into
    // save-as state with an inline form.
    await expect(page.getByTestId('demo-banner')).toBeVisible();
    // Toggle the loop bar range to dirty the doc.
    const endInput = page.locator('[data-testid="loop-end-bar"]');
    await endInput.fill('5');
    await endInput.dispatchEvent('input');
    await expect(page.getByTestId('demo-save-as')).toBeVisible({ timeout: 3_000 });
  });
});
