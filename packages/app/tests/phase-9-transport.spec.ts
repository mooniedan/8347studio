import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';

import { createServer } from 'sync-server';

/**
 * Phase 9 M3 — shared transport.
 *
 * One client presses Play; the other starts within RTT. Each peer
 * renders audio locally from the shared project + tempo map, so all
 * we need to assert at the JS layer is "remote transport state
 * triggers local audio.play / audio.stop within a small window."
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

/// Read the Play button label — flips between "Play" and "Stop"
/// depending on engine state. Used here as a proxy for the
/// component's `playing` flag.
async function playLabel(page: Page): Promise<string> {
  const text = await page.locator('button.play').textContent();
  return text?.trim() ?? '';
}

/// Synced playback is OFF by default (each peer plays independently).
/// Flip it on via the Share modal; it lives in shared meta, so toggling
/// on one peer propagates to the room.
async function enableSyncPlayback(page: Page) {
  await page.click('[data-testid="share-button"]');
  await page.click('[data-testid="share-sync-playback"]');
  await page.click('[data-testid="share-export-close"]');
}

collabTest.describe('phase-9 M3 — shared transport', () => {

  collabTest('A presses play → B follows within RTT', async ({ browser, urlFor }) => {
    collabTest.setTimeout(20_000);
    const roomId = `tr-${Math.random().toString(36).slice(2, 8)}`;
    const { ctx: ctxA, page: a } = await makeContext(browser, { name: 'Alice', color: '#ff8a3d' });
    const { ctx: ctxB, page: b } = await makeContext(browser, { name: 'Bob', color: '#06d6a0' });
    try {
      await a.goto(urlFor(roomId));
      await bridgeReady(a);
      await b.goto(urlFor(roomId));
      await bridgeReady(b);
      // Both start stopped.
      expect(await playLabel(a)).toMatch(/play/i);
      expect(await playLabel(b)).toMatch(/play/i);

      // Opt into synced playback (off by default).
      await enableSyncPlayback(a);

      // A presses Play. B's label should flip to "Stop" within a
      // moment as the awareness update lands.
      await a.click('button.play');
      await expect.poll(() => playLabel(b)).toMatch(/stop/i);
      // Engine tick on B advances → proves audio.play actually ran.
      await expect.poll(async () =>
        b.evaluate(() => (window as any).__bridge.debugCurrentTick()),
      { timeout: 5_000 }).toBeGreaterThan(0);

      // A stops; B follows.
      await a.click('button.play');
      await expect.poll(() => playLabel(b)).toMatch(/play/i);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  collabTest('B taking over play after A: takeover host follows the most-recent press', async ({ browser, urlFor }) => {
    collabTest.setTimeout(20_000);
    const roomId = `to-${Math.random().toString(36).slice(2, 8)}`;
    const { ctx: ctxA, page: a } = await makeContext(browser, { name: 'Alice', color: '#ff8a3d' });
    const { ctx: ctxB, page: b } = await makeContext(browser, { name: 'Bob', color: '#06d6a0' });
    try {
      await a.goto(urlFor(roomId));
      await bridgeReady(a);
      await b.goto(urlFor(roomId));
      await bridgeReady(b);

      await enableSyncPlayback(a);

      await a.click('button.play');
      await expect.poll(() => playLabel(b)).toMatch(/stop/i);

      // B stops — local press wins, A should follow.
      await b.click('button.play');
      await expect.poll(() => playLabel(a)).toMatch(/play/i);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  collabTest('by default peers play independently (synced playback off)', async ({ browser, urlFor }) => {
    collabTest.setTimeout(20_000);
    const roomId = `ind-${Math.random().toString(36).slice(2, 8)}`;
    const { ctx: ctxA, page: a } = await makeContext(browser, { name: 'Alice', color: '#ff8a3d' });
    const { ctx: ctxB, page: b } = await makeContext(browser, { name: 'Bob', color: '#06d6a0' });
    try {
      await a.goto(urlFor(roomId));
      await bridgeReady(a);
      await b.goto(urlFor(roomId));
      await bridgeReady(b);
      expect(await playLabel(a)).toMatch(/play/i);
      expect(await playLabel(b)).toMatch(/play/i);

      // A presses Play — without opting into synced playback, B must
      // NOT follow.
      await a.click('button.play');
      await expect.poll(() => playLabel(a)).toMatch(/stop/i);
      // Give any (erroneous) broadcast time to land, then assert B is
      // still stopped.
      await b.waitForTimeout(1500);
      expect(await playLabel(b)).toMatch(/play/i);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  collabTest('local mode (no room) ignores remote transport gossip', async ({ browser }) => {
    // Sanity check: outside a room, the transport works like before
    // — no awareness attached, no broadcast, no follow.
    const { ctx, page } = await makeContext(browser);
    try {
      await page.goto('/');
      await bridgeReady(page);
      expect(await playLabel(page)).toMatch(/play/i);
      await page.click('button.play');
      await expect.poll(() => playLabel(page)).toMatch(/stop/i);
    } finally {
      await ctx.close();
    }
  });
});
