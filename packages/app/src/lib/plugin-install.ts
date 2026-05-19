// Phase-8 M5 / M5b — third-party plugin install + reload pipeline.
//
// Pure functions for the install IO so App.svelte just owns the
// reactive `installedPlugins` $state and the picker UI. Each
// function fetches a manifest, validates it, verifies the wasm's
// SHA-256 against the manifest's SRI integrity hash, then asks the
// audio worklet to load the wasm and assigns a handle.
//
// Stateless: results are returned, never mutated in-place. The
// caller decides how to roll them into the visible list.

import { sha256 as wasmSha256 } from './plugin-loader';
import { parseManifestJson, type PluginManifest } from './plugin-manifest';
import {
  listInstalledPlugins,
  recordInstalledPlugin,
  type Project,
} from './project';

/// What the audio module / worklet exposes to us. Kept as a single
/// callback so the module is testable without standing up an
/// AudioContext.
export interface PluginInstallDeps {
  loadWasm: (
    bytes: Uint8Array,
    opts: { maxBlockSize?: number; inChannels?: number; outChannels?: number },
  ) => Promise<number>;
}

export interface InstalledPluginEntry {
  manifest: PluginManifest;
  handle: number;
  loadError?: string;
}

export type InstallResult =
  | { ok: InstalledPluginEntry }
  | { err: string };

const PLUGIN_BLOCK_OPTS = (manifest: PluginManifest) => ({
  maxBlockSize: 256,
  inChannels: manifest.kind === 'instrument' ? 0 : 1,
  outChannels: 1,
});

/// Fetch a manifest by URL, verify the wasm, hand the wasm to the
/// worklet, and persist the manifest under `meta.installedPlugins`
/// so a reload can replay this dance via `reloadInstalledPlugins`.
///
/// `existing` is the current installed-plugin list — used to dedup
/// on manifest id so installing the same plugin twice is a no-op.
export async function installPluginFromUrl(
  project: Project,
  url: string,
  existing: InstalledPluginEntry[],
  deps: PluginInstallDeps,
): Promise<InstallResult> {
  try {
    const manifestResp = await fetch(url);
    if (!manifestResp.ok) return { err: `fetch failed: ${manifestResp.status}` };
    const text = await manifestResp.text();
    const parsed = parseManifestJson(text);
    if (!parsed.ok) {
      const head = parsed.issues[0];
      return { err: `invalid manifest at ${head.path || '<root>'}: ${head.message}` };
    }
    const manifest = parsed.manifest;
    if (existing.some((p) => p.manifest.id === manifest.id)) {
      return { err: `already installed: ${manifest.id}` };
    }
    const wasmAbs = new URL(manifest.wasm, new URL(url, window.location.href)).toString();
    const wasmResp = await fetch(wasmAbs);
    if (!wasmResp.ok) return { err: `wasm fetch failed: ${wasmResp.status}` };
    const wasmBytes = new Uint8Array(await wasmResp.arrayBuffer());
    const got = `sha256-${await wasmSha256(wasmBytes)}`;
    if (got !== manifest.wasmIntegrity) {
      return {
        err: `integrity mismatch: manifest says ${manifest.wasmIntegrity}, wasm hashed to ${got}`,
      };
    }
    const handle = await deps.loadWasm(wasmBytes, PLUGIN_BLOCK_OPTS(manifest));
    // Persist a manifest variant that points at the absolute wasm URL we
    // just verified — so reload doesn't have to re-resolve a relative
    // path against the original manifest URL (which we don't keep).
    const persisted = { ...manifest, wasm: wasmAbs };
    recordInstalledPlugin(project, manifest.id, JSON.stringify(persisted));
    return { ok: { manifest, handle } };
  } catch (err) {
    return { err: `install error: ${(err as Error).message}` };
  }
}

/// Walk `meta.installedPlugins` and re-fetch+verify+register every
/// entry. Returns the new list — entries that fail to load come
/// back with `handle: 0` and a `loadError` string so the picker can
/// surface them as red FAILED cards.
export async function reloadInstalledPlugins(
  project: Project,
  deps: PluginInstallDeps,
): Promise<InstalledPluginEntry[]> {
  const stored = listInstalledPlugins(project);
  if (stored.length === 0) return [];
  const out: InstalledPluginEntry[] = [];
  for (const { manifestJson } of stored) {
    let manifest: PluginManifest;
    try {
      const parsed = parseManifestJson(manifestJson);
      if (!parsed.ok) throw new Error(parsed.issues[0]?.message ?? 'invalid manifest');
      manifest = parsed.manifest;
    } catch (err) {
      // Persisted JSON has rotted somehow; surface but don't crash —
      // the entry stays so the user can see what happened.
      out.push({
        manifest: { id: 'unknown', name: 'Unknown', version: '0.0.0', kind: 'effect',
          wasm: '', wasmIntegrity: '', params: [] },
        handle: 0,
        loadError: `bad manifest JSON: ${(err as Error).message}`,
      });
      continue;
    }
    try {
      const wasmResp = await fetch(manifest.wasm);
      if (!wasmResp.ok) throw new Error(`fetch ${manifest.wasm}: ${wasmResp.status}`);
      const wasmBytes = new Uint8Array(await wasmResp.arrayBuffer());
      const got = `sha256-${await wasmSha256(wasmBytes)}`;
      if (got !== manifest.wasmIntegrity) {
        throw new Error(`integrity drift: expected ${manifest.wasmIntegrity}, got ${got}`);
      }
      const handle = await deps.loadWasm(wasmBytes, PLUGIN_BLOCK_OPTS(manifest));
      out.push({ manifest, handle });
    } catch (err) {
      out.push({ manifest, handle: 0, loadError: (err as Error).message });
    }
  }
  return out;
}
