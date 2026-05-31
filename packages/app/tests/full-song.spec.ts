import { test, expect, type Page } from '@playwright/test';

// ♫ Full Song — the ~4-minute realistic-track showcase (separate from
// the sub-minute Demo Song canary). A multi-section arrangement
// (Intro/Verse/Chorus/Bridge/…) built from distinct per-section
// patterns, plus the real bell.wav sample.

const BAR = 3840; // PPQ 960, 4/4

interface Block { startTick: number; loop: boolean; patternId: string }

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __bridge?: object }).__bridge != null);
}

async function seedFullSong(page: Page) {
  await page.goto('/');
  await bridgeReady(page);
  await page.click('[data-testid="projects-menu"]');
  await page.click('[data-testid="projects-new-fullsong"]');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __project: { projectName: string | null } }).__project.projectName))
    .toBe('Full Song');
}

function blocks(page: Page, trackIdx: number): Promise<Block[]> {
  return page.evaluate(
    (i) => (window as unknown as { __bridge: { listBlocks: (n: number) => Block[] } }).__bridge.listBlocks(i),
    trackIdx,
  );
}

test.describe('♫ Full Song', () => {
  test('loads a ~4-minute multi-track song spanning the whole loop', async ({ page }) => {
    await seedFullSong(page);

    const shape = await page.evaluate(() => {
      const w = window as unknown as { __project: { trackCount: number; loopRegion: { endTick: number } | null } };
      return { tracks: w.__project.trackCount, loop: w.__project.loopRegion };
    });
    // Lead, Bass, Pad, Drums, Reverb Bus, Bell.
    expect(shape.tracks).toBe(6);
    // 112 bars at 110 BPM ≈ 4:04; the loop spans the whole song.
    expect(shape.loop?.endTick).toBe(112 * BAR);
    const seconds = (shape.loop!.endTick / 960) * (60 / 110);
    expect(seconds).toBeGreaterThan(230); // ~244 s
  });

  test('is arranged from distinct per-section patterns (not one looped bar)', async ({ page }) => {
    await seedFullSong(page);

    // Lead plays only the choruses + bridge → multiple blocks, 2 patterns.
    const lead = await blocks(page, 0);
    expect(lead.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lead.map((b) => b.patternId)).size).toBe(2); // chorus + bridge

    // Bass: verse / chorus / bridge are *distinct* patterns.
    const bass = await blocks(page, 1);
    expect(bass.length).toBeGreaterThanOrEqual(5);
    expect(new Set(bass.map((b) => b.patternId)).size).toBeGreaterThanOrEqual(3);

    // Drums: through-composed across all sections.
    const drums = await blocks(page, 3);
    expect(drums.length).toBeGreaterThanOrEqual(7);
    expect(new Set(drums.map((b) => b.patternId)).size).toBeGreaterThanOrEqual(4);

    // The intro (bar 0) has no lead and no bass (they enter later).
    expect(lead.some((b) => b.startTick === 0)).toBe(false);
    expect(bass.some((b) => b.startTick === 0)).toBe(false);
  });

  test('uses the real bell.wav sample on a Bell track', async ({ page }) => {
    await seedFullSong(page);

    await expect.poll(() => page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { inspectTracks: () => { name: string }[]; getAudioRegions: (i: number) => { assetHash: string }[] };
      };
      const tracks = w.__bridge.inspectTracks();
      const bellIdx = tracks.findIndex((t) => /bell/i.test(t.name));
      return bellIdx < 0 ? 0 : w.__bridge.getAudioRegions(bellIdx).length;
    }), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  });
});
