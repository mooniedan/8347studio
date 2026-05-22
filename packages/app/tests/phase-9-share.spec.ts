import { test, expect, type Page, type BrowserContext } from '@playwright/test';

import { createServer } from 'sync-server';

/**
 * Phase 9 M5 — sharing & joining a session.
 *
 * Each test spawns a fresh in-process sync-server on a random port,
 * opens two browser contexts pointed at that server via the
 * `?syncBase=` URL hook, and asserts the collab flow end-to-end.
 */

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as any).__bridge != null);
}

// Tests share a fixture that owns the server + a `urlFor(room)`
// helper that builds the in-app URL with `?room` and `?syncBase`
// already populated.
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

async function mockClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
}

async function makeContext(browser: any): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await mockClipboard(page);
  return { ctx, page };
}

collabTest.describe('phase-9 M5 — share & join', () => {

  collabTest('Share button is present and reads "Share" in local mode', async ({ browser }) => {
    const { ctx, page } = await makeContext(browser);
    try {
      await page.goto('/');
      await bridgeReady(page);
      const btn = page.getByTestId('share-button');
      await expect(btn).toBeVisible();
      await expect(btn).toContainText('Share');
      // No self-avatar until a session is active.
      await expect(page.getByTestId('collab-self-avatar')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  collabTest('two clients joining the same room sync edits', async ({ browser, urlFor }) => {
    collabTest.setTimeout(30_000);
    const roomId = `t-${Math.random().toString(36).slice(2, 8)}`;

    const { ctx: ctxA, page: a } = await makeContext(browser);
    const { ctx: ctxB, page: b } = await makeContext(browser);
    try {
      await a.goto(urlFor(roomId));
      await bridgeReady(a);
      await expect.poll(() => a.getByTestId('share-button').textContent())
        .toMatch(/connected/i);
      await expect(a.getByTestId('collab-self-avatar')).toBeVisible();

      // A adds a recognizable track. The Y.Doc update flows through
      // sync to the server.
      const beforeA = await a.evaluate(
        () => (window as any).__bridge.inspectTracks().length,
      );
      await a.click('[data-testid="add-synth-track"]');
      await expect.poll(() => a.evaluate(
        () => (window as any).__bridge.inspectTracks().length,
      )).toBe(beforeA + 1);

      // B joins the same room. Its empty Y.Doc absorbs the server's
      // state via sync step 1/2, and the new track should appear.
      await b.goto(urlFor(roomId));
      await bridgeReady(b);
      await expect.poll(() => b.getByTestId('share-button').textContent())
        .toMatch(/connected/i);

      await expect.poll(async () =>
        b.evaluate(() => (window as any).__bridge.inspectTracks().length),
      { timeout: 8_000 }).toBeGreaterThanOrEqual(beforeA + 1);

      // Round-trip: B adds a track → A sees it within RTT.
      const aAfterFirst = await a.evaluate(
        () => (window as any).__bridge.inspectTracks().length,
      );
      await b.click('[data-testid="add-drumkit-track"]');
      await expect.poll(async () =>
        a.evaluate(() => (window as any).__bridge.inspectTracks().length),
      { timeout: 8_000 }).toBe(aAfterFirst + 1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // Phase-10 polish — the project-name dropdown reflects the SHARED
  // project on both devices. The name lives in the per-machine
  // registry (never synced), so the host copies it into the synced
  // Y.Doc meta on share; both triggers then show "🔗 <name>".
  collabTest('shared session shows the same project name on both devices', async ({ browser, syncBase }) => {
    collabTest.setTimeout(30_000);
    const { ctx: ctxA, page: a } = await makeContext(browser);
    try {
      // A opens locally (no room), then starts a session.
      await a.goto(`/?syncBase=${encodeURIComponent(syncBase)}`);
      await bridgeReady(a);
      await a.click('[data-testid="share-button"]');
      await a.click('[data-testid="share-start-session"]');
      await expect(a.getByTestId('projects-menu')).toContainText('🔗');
      const roomId = await a.evaluate(
        () => new URLSearchParams(location.search).get('room'),
      );
      const sharedLabel = ((await a.getByTestId('projects-menu').textContent()) ?? '')
        .replace('▾', '').trim();
      expect(sharedLabel.startsWith('🔗')).toBe(true);

      // B joins the room — its trigger shows the same shared name.
      const { ctx: ctxB, page: b } = await makeContext(browser);
      try {
        await b.goto(`/?room=${roomId}&syncBase=${encodeURIComponent(syncBase)}`);
        await bridgeReady(b);
        await expect(b.getByTestId('projects-menu')).toContainText('🔗', { timeout: 8_000 });
        await expect
          .poll(async () => ((await b.getByTestId('projects-menu').textContent()) ?? '')
            .replace('▾', '').trim(), { timeout: 8_000 })
          .toBe(sharedLabel);
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });

  // Phase-11 M1 — the sharer owns the session; a joiner is a non-editor
  // (viewer) by default. Permission state lives in synced meta.
  collabTest('sharer becomes owner; joiner is a viewer by default', async ({ browser, syncBase }) => {
    collabTest.setTimeout(30_000);
    const { ctx: ctxA, page: a } = await makeContext(browser);
    try {
      await a.goto(`/?syncBase=${encodeURIComponent(syncBase)}`);
      await bridgeReady(a);
      const ownerId = await a.evaluate(
        () => JSON.parse(localStorage.getItem('collab.user.v1') ?? '{}').id,
      );
      // Before sharing: unowned (everyone can edit / local mode).
      expect(await a.evaluate(() => (window as any).__bridge.collabPermissions().ownerId)).toBeNull();

      await a.click('[data-testid="share-button"]');
      await a.click('[data-testid="share-start-session"]');
      // A is now the owner; no editors granted yet.
      await expect
        .poll(() => a.evaluate(() => (window as any).__bridge.collabPermissions().ownerId))
        .toBe(ownerId);
      expect(await a.evaluate(() => (window as any).__bridge.collabPermissions().editors)).toEqual([]);
      const roomId = await a.evaluate(() => new URLSearchParams(location.search).get('room'));

      // B joins → sees the same owner (synced), and B is neither owner
      // nor a granted editor.
      const { ctx: ctxB, page: b } = await makeContext(browser);
      try {
        await b.goto(`/?room=${roomId}&syncBase=${encodeURIComponent(syncBase)}`);
        await bridgeReady(b);
        const bId = await b.evaluate(
          () => JSON.parse(localStorage.getItem('collab.user.v1') ?? '{}').id,
        );
        await expect
          .poll(() => b.evaluate(() => (window as any).__bridge.collabPermissions().ownerId))
          .toBe(ownerId);
        const perms = await b.evaluate(() => (window as any).__bridge.collabPermissions());
        expect(perms.ownerId).not.toBe(bId);
        expect(perms.editors).not.toContain(bId);
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });
});
