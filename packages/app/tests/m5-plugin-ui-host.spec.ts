import { test, expect, type Page } from '@playwright/test';

// Phase-2 M5 — custom-UI mounting hook. The plugin-ui module ships the
// PluginHost contract a third-party plugin's UI module will receive in
// Phase 7. This phase only stubs the integration; we unit-test the
// host's API surface (getParam / setParam / subscribe) by driving it
// through a real Y.Doc-backed project.

const SUB_PID_FILTER_CUTOFF = 6;

async function bridgeReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __bridge?: object }).__bridge)))
    .toBe(true);
}

test.describe('phase-2 / M5 plugin custom-UI host', () => {
  test('host getParam / setParam / subscribe round-trip through Y.Doc', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    const result = await page.evaluate(() => {
      const w = window as unknown as {
        __bridge: {
          addSubtractiveTrack: () => number;
          createPluginUiHost: (idx: number) => {
            getParam: (id: number) => number | null;
            setParam: (id: number, value: number) => void;
            subscribe: (id: number, cb: (v: number) => void) => () => void;
            destroy: () => void;
          } | null;
        };
      };
      const idx = w.__bridge.addSubtractiveTrack();
      const host = w.__bridge.createPluginUiHost(idx);
      if (!host) return { ok: false, why: 'host null' };

      const events: number[] = [];
      const unsub = host.subscribe(6, (v) => events.push(v));

      // Initially no value stored — getParam returns null.
      const initial = host.getParam(6);

      // Write through host.setParam.
      host.setParam(6, 1234);
      const after = host.getParam(6);

      // Write again to verify subscribe fired both times.
      host.setParam(6, 5678);
      const after2 = host.getParam(6);

      // Unsubscribe — further writes should NOT fire the callback.
      unsub();
      host.setParam(6, 9999);

      host.destroy();

      return {
        ok: true,
        idx,
        initial,
        after,
        after2,
        events,
      };
    });

    expect(result.ok).toBe(true);
    expect(result.initial).toBeNull();
    expect(result.after).toBe(1234);
    expect(result.after2).toBe(5678);
    // The subscribe callback fired exactly twice — once for 1234, once
    // for 5678. The 9999 write happens after unsubscribe.
    expect(result.events).toEqual([1234, 5678]);
  });

  test('host setParam reaches the engine via the SAB ring', async ({ page }) => {
    await page.goto('/');
    await bridgeReady(page);

    const idx = await page.evaluate(() => {
      const w = window as unknown as { __bridge: { addSubtractiveTrack: () => number } };
      return w.__bridge.addSubtractiveTrack();
    });

    // Drive a param via the host. Engine must see the value the same
    // way it would for the host-rendered PluginPanel — proves the seam
    // is a true Phase-7 candidate, not a parallel stub.
    await page.evaluate(({ trackIdx }) => {
      const w = window as unknown as {
        __bridge: {
          createPluginUiHost: (i: number) => {
            setParam: (id: number, v: number) => void;
            destroy: () => void;
          } | null;
        };
      };
      const host = w.__bridge.createPluginUiHost(trackIdx);
      host?.setParam(6, 7777);
      host?.destroy();
    }, { trackIdx: idx });

    await expect
      .poll(
        () =>
          page.evaluate(
            ({ t, p }) => {
              const w = window as unknown as {
                __bridge: { debugTrackParam: (t: number, p: number) => Promise<number> };
              };
              return w.__bridge.debugTrackParam(t, p);
            },
            { t: idx, p: SUB_PID_FILTER_CUTOFF },
          ),
        { timeout: 3000 },
      )
      .toBeCloseTo(7777, 0);
  });
});
