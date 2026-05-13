import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 8 follow-up — new projects ship with a 4-bar loop region
 * enabled by default. Without it, a freshly-painted pattern plays
 * once and silence follows forever (the transport advances past
 * the clip's lengthTicks). The Transport UI lets users disable or
 * extend the loop.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

test.describe('default loop region', () => {

  test('fresh project ships with a 4-bar loop region', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    const lr = await page.evaluate(() => {
      const w = window as unknown as {
        __project: { loopRegion?: { startTick: number; endTick: number } | null };
      };
      return w.__project.loopRegion ?? null;
    });
    expect(lr).not.toBeNull();
    expect(lr!.startTick).toBe(0);
    // 4 bars × 16 sixteenth-steps × 240 ticks/step = 15360.
    expect(lr!.endTick).toBe(15360);
  });

  test('Loop toggle in the transport is checked on by default', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const toggle = page.locator('[data-testid="loop-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
  });

  test('engine receives the default loop region across the snapshot bridge', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);
    const loopEnd = await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { debugLoopEnd: () => Promise<number> };
      };
      return w.__bridge.debugLoopEnd();
    });
    expect(loopEnd).toBe(15360);
  });
});
