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

  // Phase-11 M2 — a viewer is read-only: "View only" banner + editing
  // controls disabled. The owner edits freely.
  collabTest('a collab viewer is read-only; the owner can edit', async ({ browser, syncBase }) => {
    collabTest.setTimeout(30_000);
    const { ctx: ctxA, page: a } = await makeContext(browser);
    try {
      await a.goto(`/?syncBase=${encodeURIComponent(syncBase)}`);
      await bridgeReady(a);
      await a.click('[data-testid="share-button"]');
      await a.click('[data-testid="share-start-session"]');
      await expect
        .poll(() => a.evaluate(() => (window as any).__bridge.collabPermissions().ownerId))
        .not.toBeNull();
      await a.click('[data-testid="share-export-close"]');
      // Owner: no view-only banner; editing enabled.
      await expect(a.locator('[data-testid="viewonly-banner"]')).toHaveCount(0);
      await expect(a.locator('[data-testid="add-synth-track"]')).toBeEnabled();
      const roomId = await a.evaluate(() => new URLSearchParams(location.search).get('room'));

      const { ctx: ctxB, page: b } = await makeContext(browser);
      try {
        await b.goto(`/?room=${roomId}&syncBase=${encodeURIComponent(syncBase)}`);
        await bridgeReady(b);
        // Viewer: banner shown, structural + tempo controls disabled.
        await expect(b.locator('[data-testid="viewonly-banner"]')).toBeVisible();
        await expect(b.locator('[data-testid="add-synth-track"]')).toBeDisabled();
        await expect(b.locator('[data-testid="add-track"]')).toBeDisabled();
        await expect(b.locator('[data-testid="bpm-input"]')).toBeDisabled();
        await expect(b.locator('[data-testid="canvas"]')).toHaveClass(/readonly/);
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });

  // Phase-11 M4 — the owner grants a viewer edit access from the
  // collaborator roster; the viewer's lock lifts. Revoke re-locks.
  collabTest('owner grants a viewer edit access; revoke re-locks', async ({ browser, syncBase }) => {
    collabTest.setTimeout(30_000);
    const { ctx: ctxA, page: a } = await makeContext(browser);
    try {
      await a.goto(`/?syncBase=${encodeURIComponent(syncBase)}`);
      await bridgeReady(a);
      await a.click('[data-testid="share-button"]');
      await a.click('[data-testid="share-start-session"]');
      await expect
        .poll(() => a.evaluate(() => (window as any).__bridge.collabPermissions().ownerId))
        .not.toBeNull();
      const roomId = await a.evaluate(() => new URLSearchParams(location.search).get('room'));
      // Leave A's modal open on the Share-live tab to manage the roster.

      const { ctx: ctxB, page: b } = await makeContext(browser);
      try {
        await b.goto(`/?room=${roomId}&syncBase=${encodeURIComponent(syncBase)}`);
        await bridgeReady(b);
        await expect(b.locator('[data-testid="viewonly-banner"]')).toBeVisible();
        await expect(b.locator('[data-testid="add-synth-track"]')).toBeDisabled();

        // B shows up in A's roster with a grant toggle; grant it.
        const grant = a.locator('[data-testid^="share-grant-"]');
        await expect(grant).toBeVisible({ timeout: 8_000 });
        await grant.click();

        // B can now edit.
        await expect(b.locator('[data-testid="viewonly-banner"]')).toHaveCount(0);
        await expect(b.locator('[data-testid="add-synth-track"]')).toBeEnabled();

        // Revoke → B is locked again.
        await grant.click();
        await expect(b.locator('[data-testid="viewonly-banner"]')).toBeVisible();
        await expect(b.locator('[data-testid="add-synth-track"]')).toBeDisabled();
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });

  // Phase-10 P6 — a read-only viewer cannot import audio. The owner
  // shares a project that already contains an audio track; the viewer
  // adopts it, selects it, and finds the Import… button disabled. A
  // programmatically dispatched drop bypasses the canvas's
  // pointer-events:none (CSS doesn't stop dispatchEvent), so this also
  // proves the explicit `canEdit` guard in the drop handler — not just
  // the CSS lock — keeps a viewer from writing a region.
  collabTest('a read-only viewer cannot import audio onto a shared track', async ({ browser, syncBase }) => {
    collabTest.setTimeout(30_000);
    const { ctx: ctxA, page: a } = await makeContext(browser);
    try {
      await a.goto(`/?syncBase=${encodeURIComponent(syncBase)}`);
      await bridgeReady(a);
      await a.click('[data-testid="share-button"]');
      await a.click('[data-testid="share-start-session"]');
      await expect
        .poll(() => a.evaluate(() => (window as any).__bridge.collabPermissions().ownerId))
        .not.toBeNull();
      await a.click('[data-testid="share-export-close"]');

      // Owner adds an audio track (synced) — it lands at index 1 after
      // the default synth track.
      await a.click('[data-testid="add-audio-track"]');
      const audioIdx = await a.evaluate(() => (window as any).__project.trackCount - 1);
      const roomId = await a.evaluate(() => new URLSearchParams(location.search).get('room'));

      const { ctx: ctxB, page: b } = await makeContext(browser);
      try {
        await b.goto(`/?room=${roomId}&syncBase=${encodeURIComponent(syncBase)}`);
        await bridgeReady(b);
        await expect(b.locator('[data-testid="viewonly-banner"]')).toBeVisible();

        // Viewer adopts the synced audio track and selects it (selection
        // is local view state, allowed for viewers).
        await expect
          .poll(() => b.evaluate(() => (window as any).__project.trackCount))
          .toBeGreaterThan(audioIdx);
        await b.click(`[data-testid="track-row-${audioIdx}"]`);

        // The Import… button is disabled for the viewer.
        await expect(b.locator(`[data-testid="audio-track-${audioIdx}-import"]`)).toBeDisabled();

        // Dispatch a real drop with a WAV file — the canEdit guard must
        // drop it on the floor: no region is created.
        await b.evaluate((idx) => {
          const sr = 48_000, frames = Math.round(0.3 * sr), dataLen = frames * 2;
          const ab = new ArrayBuffer(44 + dataLen);
          const dv = new DataView(ab); let p = 0;
          const wStr = (s: string) => { for (const c of s) dv.setUint8(p++, c.charCodeAt(0)); };
          const wU32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
          const wU16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
          wStr('RIFF'); wU32(36 + dataLen); wStr('WAVE'); wStr('fmt ');
          wU32(16); wU16(1); wU16(1); wU32(sr); wU32(sr * 2); wU16(2); wU16(16);
          wStr('data'); wU32(dataLen);
          for (let i = 0; i < frames; i++) dv.setInt16(p + i * 2, 1000, true);
          const file = new File([new Uint8Array(ab)], 'sneak.wav', { type: 'audio/wav' });
          const dt = new DataTransfer(); dt.items.add(file);
          const section = document.querySelector(`[data-testid="audio-track-${idx}"]`)!;
          const rect = section.getBoundingClientRect();
          const init: DragEventInit = {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: rect.left + 80, clientY: rect.top + rect.height / 2,
          };
          section.dispatchEvent(new DragEvent('dragover', init));
          section.dispatchEvent(new DragEvent('drop', init));
        }, audioIdx);

        // Give any (incorrect) import a chance to land, then confirm none did.
        await b.waitForTimeout(500);
        expect(await b.evaluate((i) => (window as any).__bridge.getAudioRegions(i).length, audioIdx)).toBe(0);
      } finally {
        await ctxB.close();
      }
    } finally {
      await ctxA.close();
    }
  });
});
