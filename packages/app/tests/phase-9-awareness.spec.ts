import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';

import { createServer } from 'sync-server';

/**
 * Phase 9 M4 — collab awareness UI.
 *
 * Two contexts sharing a room should:
 *   - See each other's avatars in the top bar.
 *   - See ghost selection rings on track rows the other peer has selected.
 *   - See ghost cell highlights in the piano-roll when the other peer
 *     hovers a cell.
 */

const collabTest = test.extend<{
  syncBase: string;
  urlFor: (roomId: string) => string;
}>({
  syncBase: async ({}, use) => {
    const srv = await createServer({ port: 0 });
    try {
      await use(`ws://127.0.0.1:${srv.port}`);
    } finally {
      await srv.close();
    }
  },
  urlFor: async ({ syncBase }, use) => {
    use((roomId: string) =>
      `/?room=${encodeURIComponent(roomId)}&syncBase=${encodeURIComponent(syncBase)}`,
    );
  },
});

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

async function makeContext(
  browser: Browser,
  user?: { name: string; color: string },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.addInitScript((u) => {
    if (u) localStorage.setItem('collab.user.v1', JSON.stringify(u));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  }, user);
  return { ctx, page };
}

collabTest.describe('phase-9 M4 — awareness UI', () => {

  collabTest('peer avatar appears in the top bar after a second client joins', async ({ browser, urlFor }) => {
    collabTest.setTimeout(20_000);
    const roomId = `aw-${Math.random().toString(36).slice(2, 8)}`;

    const userA = { name: 'Alice', color: '#ff8a3d' };
    const userB = { name: 'Bob',   color: '#06d6a0' };

    const { ctx: ctxA, page: a } = await makeContext(browser, userA);
    const { ctx: ctxB, page: b } = await makeContext(browser, userB);
    try {
      await a.goto(urlFor(roomId));
      await bridgeReady(a);
      await expect(a.getByTestId('collab-self-avatar')).toHaveText('A');
      // No peers yet.
      await expect(a.locator('[data-testid^="collab-peer-avatar-"]')).toHaveCount(0);

      await b.goto(urlFor(roomId));
      await bridgeReady(b);

      // A now sees Bob's avatar; B sees Alice's.
      await expect.poll(() =>
        a.locator('[data-testid^="collab-peer-avatar-"]').count(),
      ).toBeGreaterThanOrEqual(1);
      await expect.poll(() =>
        b.locator('[data-testid^="collab-peer-avatar-"]').count(),
      ).toBeGreaterThanOrEqual(1);

      // Peer avatar's initial = first letter of the peer's name.
      const peerAOnB = b.locator('[data-testid^="collab-peer-avatar-"]').first();
      await expect(peerAOnB).toHaveText('A');
      const peerBOnA = a.locator('[data-testid^="collab-peer-avatar-"]').first();
      await expect(peerBOnA).toHaveText('B');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  collabTest('selecting a track on A shows a ghost ring on B', async ({ browser, urlFor }) => {
    collabTest.setTimeout(20_000);
    const roomId = `sel-${Math.random().toString(36).slice(2, 8)}`;
    const { ctx: ctxA, page: a } = await makeContext(browser, { name: 'Alice', color: '#ff8a3d' });
    const { ctx: ctxB, page: b } = await makeContext(browser, { name: 'Bob',   color: '#06d6a0' });
    try {
      await a.goto(urlFor(roomId));
      await bridgeReady(a);
      // Add an extra track so we have at least two rows to pick between.
      await a.click('[data-testid="add-synth-track"]');
      await expect.poll(() => a.evaluate(
        () => (window as any).__bridge.inspectTracks().length,
      )).toBe(2);

      await b.goto(urlFor(roomId));
      await bridgeReady(b);
      // Wait for the doc to sync — B should see two tracks too.
      await expect.poll(() => b.evaluate(
        () => (window as any).__bridge.inspectTracks().length,
      )).toBeGreaterThanOrEqual(2);

      // A selects track 1 (the second one). The ghost ring should
      // appear on track row 1 in B's UI.
      await a.click('[data-testid="track-row-1"]');
      await expect(b.getByTestId('track-peer-marker-1')).toBeVisible({ timeout: 5_000 });
      // The dot uses the peer's color (Alice = #ff8a3d).
      const peerDot = b.getByTestId('track-peer-marker-1').locator('.peer-dot').first();
      await expect(peerDot).toHaveCSS('background-color', 'rgb(255, 138, 61)');

      // B selects track 0 — A should mirror.
      await b.click('[data-testid="track-row-0"]');
      await expect(a.getByTestId('track-peer-marker-0')).toBeVisible({ timeout: 5_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
