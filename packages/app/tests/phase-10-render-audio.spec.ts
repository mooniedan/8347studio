import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * Phase 10 M7d — render to audio.
 *
 * The Render tab drives an offline render (engine WASM in a Web
 * Worker) to a WAV. UI tests cover the controls; the e2e test seeds
 * the Demo Song (real musical content) and renders it, asserting a
 * valid, non-silent WAV comes back.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function openRenderTab(page: Page) {
  await page.click('[data-testid="share-button"]');
  await page.click('[data-testid="share-tab-render"]');
}

test.describe('phase-10 M7d — Render audio', () => {

  test('render tab: WAV active, FLAC/MP3 disabled, dry-run estimate shown', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    await openRenderTab(page);
    await expect(page.locator('[data-testid="share-render-format-WAV"]')).toBeEnabled();
    await expect(page.locator('[data-testid="share-render-format-FLAC"]')).toBeDisabled();
    await expect(page.locator('[data-testid="share-render-format-MP3"]')).toBeDisabled();
    // Dry-run estimate reads as mm:ss.xx.
    await expect(page.locator('[data-testid="share-render-estimate"]')).toHaveText(/^\d{2}:\d{2}\.\d{2}$/);
  });

  test('renders the Demo Song to a non-silent WAV', async ({ page }) => {
    test.setTimeout(40_000);
    await page.goto('/');
    await bridgeReady(page);

    // Seed the Demo Song — real synth/sequencer content.
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect
      .poll(() => page.evaluate(() => (window as any).__project.trackCount))
      .toBeGreaterThan(1);

    await openRenderTab(page);
    // Loop region keeps the render short but covers the content.
    await page.click('[data-testid="share-render-range-loop"]');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-testid="share-render-run"]'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.wav$/);

    const path = await download.path();
    const bytes = new Uint8Array(await readFile(path));

    // Valid RIFF/WAVE header.
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
    // Meaningful amount of audio data (well past the 44-byte header).
    expect(bytes.byteLength).toBeGreaterThan(44 + 10_000);
    // Non-silent: at least one non-zero PCM byte past the header.
    const data = bytes.subarray(44);
    expect(data.some((b) => b !== 0)).toBe(true);
  });
});
