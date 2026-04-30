import { test, expect, type Page } from '@playwright/test';

// M4 verifies the engine's musical-time accounting:
//   1. Pressing play advances the engine's current_tick; pressing stop
//      freezes (and resets) it.
//   2. BPM edits flow through Y.Doc → engine-bridge → SAB → engine, and
//      doubling BPM doubles the tick advancement rate.

async function bridgeReady(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge))).toBe(true);
}

async function currentTick(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const w = window as unknown as { __bridge: { debugCurrentTick: () => Promise<number> } };
    return w.__bridge.debugCurrentTick();
  });
}

async function setBpm(page: Page, bpm: number) {
  await page.evaluate((v) => {
    const el = document.querySelector('input[type="number"]') as HTMLInputElement;
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, bpm);
}

test.describe('phase-1 / M4 tempo & transport', () => {
  test('current_tick advances under play and freezes on stop', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    expect(await currentTick(page)).toBe(0);
    await page.click('button.play');
    await expect.poll(() => currentTick(page), { timeout: 2000 }).toBeGreaterThan(0);

    await page.click('button.play'); // stop
    const stopped = await currentTick(page);
    await page.waitForTimeout(120);
    const later = await currentTick(page);
    // Stop resets to 0 and stays there.
    expect(stopped).toBe(0);
    expect(later).toBe(0);
  });

  test('BPM change doubles the tick rate', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await setBpm(page, 60);
    await page.click('button.play');
    await page.waitForTimeout(300);
    const slow = await currentTick(page);
    await page.click('button.play'); // stop → resets

    await setBpm(page, 240);
    await page.click('button.play');
    await page.waitForTimeout(300);
    const fast = await currentTick(page);

    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(0);
    // 240 / 60 = 4× the tick rate. Tolerate ±30% to absorb timing jitter.
    const ratio = fast / slow;
    expect(ratio).toBeGreaterThan(2.8);
    expect(ratio).toBeLessThan(5.2);
  });
});
