// Phase-2 M5: plugin custom-UI mounting contract (stub).
//
// In Phase 7 a third-party plugin is delivered as:
//
//   /// plugin manifest (JSON, fetched at load time)
//   { id, name, version, kind, descriptors[], wasm: <url>, ui?: <url> }
//
// If `ui` is set, the host fetches that URL as a JS module that exports
//   `createUI(host: PluginHost): HTMLElement`
// and mounts the returned element inside a sandboxed custom-element. The
// plugin sees ONLY the parameter surface (getParam/setParam/subscribe);
// it has no DOM access to the rest of the app, no fetch, no postMessage.
//
// Phase-2 ships only the contract types and a working PluginHost
// factory. The first-party subtractive synth uses host-rendered UI
// (PluginPanel.svelte) and never touches this module — it exists so
// the seam is present and unit-testable from day one.

import * as Y from 'yjs';
import { type Project, getSynthParam, setSynthParam } from './project';

/// Manifest shape a Phase-7 third-party plugin will ship. Subset
/// pinned today; later phases extend backwards-compatibly.
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: 'instrument' | 'effect' | 'container';
  /// URL to the WASM module. Phase-2 stub — not yet wired.
  wasm?: string;
  /// Optional URL of the custom-UI JS module. If absent, the host
  /// renders the default knob/slider panel from the descriptor list
  /// (PluginPanel.svelte today).
  ui?: string;
}

/// API surface a plugin's custom UI sees. Strictly parameter-scoped:
/// no DOM, no network, no app state.
export interface PluginHost {
  /// Read the current value of a parameter. Returns null if the host
  /// has no value yet (UI should fall back to the descriptor default).
  getParam(id: number): number | null;
  /// Write a parameter. Flows through Y.Doc → SAB ring → engine.
  setParam(id: number, value: number): void;
  /// Subscribe to changes for one parameter. Returns an unsubscribe
  /// function. Multiple subscribers per param are supported.
  subscribe(id: number, cb: (value: number) => void): () => void;
  /// Drop every subscriber. Called when the panel unmounts.
  destroy(): void;
}

/// Factory used by the Phase-2 first-party panel test, and by the
/// Phase-7 plugin loader when it instantiates a third-party UI module.
export function createPluginUiHost(project: Project, trackIdx: number): PluginHost {
  const subscribers = new Map<number, Set<(value: number) => void>>();
  let unobserve: (() => void) | null = null;

  const getParamsMap = (): Y.Map<unknown> | null => {
    if (trackIdx < 0 || trackIdx >= project.tracks.length) return null;
    const id = project.tracks.get(trackIdx);
    const track = project.trackById.get(id);
    const instr = track?.get('instrumentSlot') as Y.Map<unknown> | undefined;
    return (instr?.get('params') as Y.Map<unknown> | undefined) ?? null;
  };

  const params = getParamsMap();
  if (params) {
    const handler = (ev: Y.YMapEvent<unknown>) => {
      ev.changes.keys.forEach((_change, key) => {
        const id = parseInt(key, 10);
        if (Number.isNaN(id)) return;
        const v = params.get(key);
        if (typeof v !== 'number') return;
        const subs = subscribers.get(id);
        if (subs) {
          for (const cb of subs) cb(v);
        }
      });
    };
    params.observe(handler);
    unobserve = () => params.unobserve(handler);
  }

  return {
    getParam(id) {
      return getSynthParam(project, trackIdx, id);
    },
    setParam(id, value) {
      setSynthParam(project, trackIdx, id, value);
    },
    subscribe(id, cb) {
      let set = subscribers.get(id);
      if (!set) {
        set = new Set();
        subscribers.set(id, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
    destroy() {
      subscribers.clear();
      unobserve?.();
      unobserve = null;
    },
  };
}

/// Phase-7 will replace this stub with an actual fetch-and-instantiate
/// path. Today it lives here so the seam is testable.
export type CreateUI = (host: PluginHost) => HTMLElement;
