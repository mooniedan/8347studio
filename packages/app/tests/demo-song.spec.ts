import { test, expect, type Page } from '@playwright/test';

// Demo Song — built-in feature-tour project + the project's
// cumulative audible regression test.
//
// Project-level commitment (.claude/overview-plan.md cross-cutting
// commitment #7 / CLAUDE.md):
//   Every new user-facing feature that can live in a project MUST:
//     1. Add a block to `seedDemoSong` in
//        packages/app/src/lib/project.ts.
//     2. Add the matching assertion below.
//     3. Be audibly exercised when the user clicks "★ Demo Song"
//        from a clean slate.
//   This file is the canary for "what works end-to-end today." If
//   you shipped a feature and didn't grow this spec, the demo
//   drifted away from reality — please fix it before merging.

interface ProjectShape {
  trackCount: number;
  clipCount: number;
  projectName: string | null;
}

interface TrackInfo {
  idx: number;
  name: string;
  color: string;
  inserts: { kind: string }[];
  sends: { targetTrackIdx: number; level: number }[];
}

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

async function projectShape(page: Page): Promise<ProjectShape> {
  return page.evaluate(() => {
    const w = window as unknown as { __project: ProjectShape };
    return {
      trackCount: w.__project.trackCount,
      clipCount: w.__project.clipCount,
      projectName: w.__project.projectName,
    };
  });
}

async function inspectTracks(page: Page): Promise<TrackInfo[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __bridge: { inspectTracks: () => TrackInfo[] } };
    return w.__bridge.inspectTracks();
  });
}

async function pianoRollNoteCount(page: Page, trackIdx: number): Promise<number> {
  return page.evaluate((idx) => {
    const w = window as unknown as { __bridge: { getPianoRollNotes: (i: number) => unknown[] } };
    return w.__bridge.getPianoRollNotes(idx).length;
  }, trackIdx);
}

async function automationLaneCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __bridge: { listAutomationLanes: () => unknown[] } };
    return w.__bridge.listAutomationLanes().length;
  });
}

async function bpm(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __bridge: { debugBpm: () => number } };
    return w.__bridge.debugBpm();
  });
}

test.describe('demo song', () => {
  test('★ Demo Song button seeds the feature-tour project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Default project shipped with seedDefaults — confirm we start blank.
    expect((await projectShape(page)).trackCount).toBe(1);

    // Open menu → click "★ Demo Song".
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await bridgeReady(page);

    // Wait for the doc to settle.
    await expect.poll(() => projectShape(page).then((s) => s.projectName)).toBe('Demo Song');

    const shape = await projectShape(page);
    expect(shape.projectName).toBe('Demo Song');
    expect(shape.trackCount).toBeGreaterThanOrEqual(4);

    // Tempo set by the seeder.
    await expect.poll(() => bpm(page)).toBe(110);

    const tracks = await inspectTracks(page);

    // Track 0: lead synth — has EQ + Compressor + Container inserts.
    const leadInsertKinds = tracks[0].inserts.map((s) => s.kind);
    expect(leadInsertKinds).toContain('builtin:eq');
    expect(leadInsertKinds).toContain('builtin:compressor');
    expect(leadInsertKinds).toContain('builtin:container');

    // Track 0 has at least one send into the reverb bus.
    expect(tracks[0].sends.length).toBeGreaterThanOrEqual(1);

    // Track 2 is the reverb bus — has a reverb insert.
    expect(tracks[2].name).toMatch(/Reverb/i);
    expect(tracks[2].inserts.map((s) => s.kind)).toContain('builtin:reverb');

    // Lead has piano-roll notes seeded for the chord progression.
    expect(await pianoRollNoteCount(page, 0)).toBeGreaterThanOrEqual(8);

    // Automation lane present on track 0.
    expect(await automationLaneCount(page)).toBeGreaterThanOrEqual(1);

    // Transport loop region set so the demo cycles end-to-end.
    const loop = await page.evaluate(() => {
      const meta = (window as unknown as {
        __project: { loopRegion?: { startTick: number; endTick: number } | null };
      }).__project.loopRegion ?? null;
      return meta;
    });
    expect(loop).not.toBeNull();
    expect(loop!.endTick).toBeGreaterThan(loop!.startTick);

    // Phase-7 M3 — per-track identity color. The seed overrides the
    // default round-robin palette with semantic colors; all four are
    // distinct.
    const colors = tracks.slice(0, 4).map((t) => t.color.toLowerCase());
    expect(colors[0]).toBe('#ff8a3d'); // Lead — orange
    expect(colors[1]).toBe('#4a9eff'); // Bass — blue
    expect(colors[2]).toBe('#a06bff'); // Reverb Bus — purple
    expect(colors[3]).toBe('#5fc36b'); // Drums — green
    expect(new Set(colors).size).toBe(4);

    // Phase-8 M6 — bitcrusher WASM plugin is attached to the bass
    // track as an insert. The enrichment runs asynchronously after
    // bootProject so poll until it lands.
    await expect.poll(async () => {
      const ts = await inspectTracks(page);
      return ts[1]?.inserts.map((s) => s.kind) ?? [];
    }).toContain('wasm');

    // Phase-8 M2 — drumkit track. Lives at idx 3, uses the drumkit
    // instrument, and has a piano-roll clip seeded with the kick /
    // snare / hat pattern. Hits land at GM drum-map pitches (36 / 38
    // / 42 / 46) so the demo audibly grooves without a bundled sample.
    expect(tracks[3].name).toMatch(/drums/i);
    const drumNotes = await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { getPianoRollNotes: (i: number) => { pitch: number }[] };
      };
      return w.__bridge.getPianoRollNotes(3);
    });
    expect(drumNotes.length).toBeGreaterThanOrEqual(30);
    const pitches = new Set(drumNotes.map((n) => n.pitch));
    expect(pitches).toContain(36); // kick
    expect(pitches).toContain(38); // snare
    expect(pitches).toContain(42); // closed hat
    expect(pitches).toContain(46); // open hat

    // Phase-3 M4 — a stored MIDI Learn binding survives in the seed
    // so the demo demonstrates the workflow even without a hardware
    // controller present. CC#74 → lead filter cutoff (paramId 6).
    const binding = await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: { getMidiBinding: (cc: number) => { trackIdx: number; paramId: number } | null };
      };
      return w.__bridge.getMidiBinding(74);
    });
    expect(binding).not.toBeNull();
    expect(binding!.trackIdx).toBe(0);
    expect(binding!.paramId).toBe(6);
  });

  test('loop toggle + bar inputs control project.meta.loopRegion', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Fresh projects ship with a 4-bar loop enabled — so freshly-painted
    // patterns play continuously without the user discovering the toggle.
    await expect(page.locator('[data-testid="loop-toggle"]')).toBeChecked();
    await expect.poll(async () => {
      const lr = await page.evaluate(() => {
        const w = window as unknown as {
          __project: { loopRegion?: { startTick: number; endTick: number } | null };
        };
        return w.__project.loopRegion ?? null;
      });
      return lr ? `${lr.startTick}-${lr.endTick}` : 'none';
    }).toBe('0-15360'); // 4 bars × 16 steps × 240 ticks

    // Edit end bar to 2 → loop end shrinks to 7680.
    const endInput = page.locator('[data-testid="loop-end-bar"]');
    await endInput.fill('2');
    await endInput.dispatchEvent('input');
    await expect.poll(async () => {
      const lr = await page.evaluate(() => {
        const w = window as unknown as {
          __project: { loopRegion?: { startTick: number; endTick: number } | null };
        };
        return w.__project.loopRegion ?? null;
      });
      return lr?.endTick ?? -1;
    }).toBe(7680);

    // Disable loop → meta cleared.
    await page.locator('[data-testid="loop-toggle"]').uncheck();
    await expect.poll(async () => {
      return page.evaluate(() => {
        const w = window as unknown as {
          __project: { loopRegion?: { startTick: number; endTick: number } | null };
        };
        return w.__project.loopRegion;
      });
    }).toBeNull();
  });

  test('engine receives loop region and wraps tick during playback', async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto('/');
    await bridgeReady(page);

    // Create the demo project — its seeder sets a 4-bar loop region.
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await bridgeReady(page);
    await expect.poll(() => projectShape(page).then((s) => s.projectName)).toBe('Demo Song');

    // Engine-side readback proves the snapshot wire format carried
    // the loop region across the JS → wasm boundary.
    const loopEnd = await page.evaluate(() => {
      const w = window as unknown as { __bridge: { debugLoopEnd: () => Promise<number> } };
      return w.__bridge.debugLoopEnd();
    });
    expect(loopEnd).toBe(15360); // 4 bars × 16 steps × 240 ticks

    // Press play, run for slightly longer than one 4-bar iteration
    // (~8.7 s @ 110 BPM) and confirm the playhead wrapped — i.e.
    // current_tick after the wait is below loop_end.
    await page.click('button.play');
    await page.waitForTimeout(10_000);
    const tick = await page.evaluate(() => {
      const w = window as unknown as { __bridge: { debugCurrentTick: () => Promise<number> } };
      return w.__bridge.debugCurrentTick();
    });
    await page.click('button.play'); // stop
    expect(tick).toBeLessThan(loopEnd);
    expect(tick).toBeGreaterThanOrEqual(0);
  });

  test('switching lead → bass keeps the bass waveform as saw', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // Seed the demo: track 0 is Lead (Subtractive), track 1 is Bass
    // (oscillator + step-seq, waveform=saw).
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await bridgeReady(page);
    await expect.poll(() => projectShape(page).then((s) => s.projectName)).toBe('Demo Song');

    // Lead is selected by default (it's track 0). Switch to bass.
    await page.click('[data-testid="track-row-1"]');

    // The Sequencer's waveform dropdown for the bass must show 'saw'.
    // Regression: the per-track wave reader was hardcoded to track 0,
    // so mounting Sequencer for bass overwrote its saw with sine.
    await expect(page.locator('select').first()).toHaveValue('saw');
  });

  test('demo song is ephemeral — reload drops the demo and lands on a regular project', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await bridgeReady(page);
    await expect.poll(() => projectShape(page).then((s) => s.projectName)).toBe('Demo Song');
    // Banner is visible while we're in the demo slot.
    await expect(page.getByTestId('demo-banner')).toBeVisible();

    await page.reload();
    await bridgeReady(page);

    // After reload the demo is gone; we land on whatever regular
    // project was last opened (default 'My Project', or any other).
    await expect.poll(() => projectShape(page).then((s) => s.projectName)).not.toBe('Demo Song');
    await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  });

  test('★ Demo Song re-seeds fresh on each click (no stacking duplicates)', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    // First click — fresh demo.
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await expect.poll(() => projectShape(page).then((s) => s.projectName)).toBe('Demo Song');
    const firstShape = await projectShape(page);

    // Make an edit to dirty the demo (add another synth track).
    await page.getByTestId('add-synth-track').click();

    // Click ★ Demo Song again — should re-seed, not stack.
    await page.click('[data-testid="projects-menu"]');
    await page.click('[data-testid="projects-new-demo"]');
    await page.waitForTimeout(200);
    const secondShape = await projectShape(page);
    expect(secondShape.trackCount).toBe(firstShape.trackCount);

    // Registry should NOT have multiple Demo Song entries.
    const demoCount = await page.evaluate(() => {
      const raw = localStorage.getItem('8347-studio-projects');
      const reg = raw ? JSON.parse(raw) : { projects: [] };
      return reg.projects.filter((p: { name: string }) => p.name === 'Demo Song').length;
    });
    expect(demoCount).toBe(0);
  });
});
