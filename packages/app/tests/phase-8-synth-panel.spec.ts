import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 M8 — Subtractive Synth panel polish. Visual + structural
 * upgrades; functional behaviour is covered by m3-plugin-panel.spec.
 * Here we lock the new affordances: section headers, preset chip,
 * ADSR envelope shape view, mono numerics throughout.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function addSynthAndSelect(page: Page): Promise<number> {
  await page.click('[data-testid="add-synth-track"]');
  const idx = await page.evaluate(() => {
    const w = window as unknown as { __project: { trackCount: number } };
    return w.__project.trackCount - 1;
  });
  await page.click(`[data-testid="track-row-${idx}"]`);
  await expect(page.locator('[data-testid="plugin-panel"]')).toBeVisible();
  return idx;
}

test.describe('phase-8 M8 — Subtractive Synth panel', () => {

  test('panel header carries the plugin name + preset chip', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await addSynthAndSelect(page);

    const panel = page.locator('[data-testid="plugin-panel"]');
    await expect(panel).toContainText(/subtractive/i);
    await expect(page.getByTestId('plugin-preset')).toBeVisible();
  });

  test('each group has a small-caps header', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await addSynthAndSelect(page);

    // The grouping helper splits the 18 subtractive descriptors into
    // 5 groups: osc, filter, amp, filter_env (envelope params), master.
    // Confirm each renders a header testid.
    for (const g of ['osc', 'filter', 'amp', 'filter_env']) {
      await expect(page.locator(`[data-testid="plugin-group-${g}"]`)).toBeVisible();
    }
  });

  test('envelope groups show an ADSR shape view', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await addSynthAndSelect(page);

    // Two envelopes — amp + filter — each should render the shape SVG.
    // Selector counts the ADSR shapes regardless of which group they
    // sit in.
    await expect(page.getByTestId('adsr-shape').first()).toBeVisible();
    const count = await page.getByTestId('adsr-shape').count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('param value readouts use the IBM Plex Mono token', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await addSynthAndSelect(page);

    // Filter cutoff = param id 6. Its formatted value sits in the
    // `.val.mono` span of its ParamControl.
    const family = await page.locator('[data-testid="param-6-value"]').evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(family).toContain('IBM Plex Mono');
  });

  test('changing a param updates the visible readout', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const idx = await addSynthAndSelect(page);

    // Move cutoff to 8000 Hz via the bridge — the readout should reflect
    // the new value within a frame.
    await page.evaluate(({ idx }) => {
      (window as any).__bridge.setSynthParam(idx, 6, 8000);
    }, { idx });

    await expect(page.locator('[data-testid="param-6-value"]')).toContainText(/8\.00 kHz|8000 Hz/);
  });
});
