// Phase-10 M7b/M7c — project export/import bundles.
//
// A bundle is a single zip:
//   project.yjs          — Y.encodeStateAsUpdate(doc) (full project state)
//   assets/<sha>.bin     — the OPFS-stored source bytes for each
//                          referenced asset (only when includeAudio)
//   manifest.json        — what's inside + per-asset metadata
//
// Export walks the live Y.Doc; import hydrates a fresh doc and drops
// the asset bytes back into OPFS by their content hash.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import * as Y from 'yjs';
import * as assetStore from './asset-store';
import { getAssetMetadata, type Project } from './project';

export const BUNDLE_EXT = '.8347.zip';
const PROJECT_ENTRY = 'project.yjs';
const MANIFEST_ENTRY = 'manifest.json';

export interface BundleAssetEntry {
  hash: string;
  file: string;
  bytes: number;
  sourceFilename?: string;
  sampleRate?: number;
  channels?: number;
  frames?: number;
}

export interface BundleManifest {
  format: '8347-bundle';
  version: 1;
  name: string;
  createdAt: string;
  project: typeof PROJECT_ENTRY;
  includeAudio: boolean;
  assets: BundleAssetEntry[];
}

export interface BuiltBundle {
  zip: Uint8Array;
  manifest: BundleManifest;
  /// Uncompressed sum of all entries — what the UI shows as the
  /// estimated size (the zip itself is smaller after deflate).
  totalBytes: number;
}

/// Raw bytes for each referenced asset present in OPFS. Hashes the
/// project knows about but that never landed locally (a peer holds
/// them) are pulled down first, then skipped if still unavailable.
async function collectAssets(project: Project): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const hash of project.assets.keys()) {
    await assetStore.ensureLocal(hash);
    const bytes = await assetStore.get(hash);
    if (bytes) out.set(hash, bytes);
  }
  return out;
}

export async function buildBundle(
  project: Project,
  name: string,
  includeAudio: boolean,
): Promise<BuiltBundle> {
  const projectBytes = Y.encodeStateAsUpdate(project.doc);
  const files: Record<string, Uint8Array> = { [PROJECT_ENTRY]: projectBytes };
  const assets: BundleAssetEntry[] = [];
  let totalBytes = projectBytes.byteLength;

  if (includeAudio) {
    const collected = await collectAssets(project);
    for (const [hash, bytes] of collected) {
      const file = `assets/${hash}.bin`;
      files[file] = bytes;
      totalBytes += bytes.byteLength;
      const meta = getAssetMetadata(project, hash);
      assets.push({
        hash,
        file,
        bytes: bytes.byteLength,
        sourceFilename: meta?.sourceFilename,
        sampleRate: meta?.sampleRate,
        channels: meta?.channels,
        frames: meta?.frames,
      });
    }
  }

  const manifest: BundleManifest = {
    format: '8347-bundle',
    version: 1,
    name,
    createdAt: new Date().toISOString(),
    project: PROJECT_ENTRY,
    includeAudio,
    assets,
  };
  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
  files[MANIFEST_ENTRY] = manifestBytes;
  totalBytes += manifestBytes.byteLength;

  const zip = zipSync(files, { level: 6 });
  return { zip, manifest, totalBytes };
}

/// Cheap-ish size estimate for the export panel: project state plus
/// each locally-available referenced asset. Reads asset bytes, so it
/// scales with the project's audio — fine for the sizes we ship.
export async function estimateBundle(
  project: Project,
  includeAudio: boolean,
): Promise<{ bytes: number; assetCount: number }> {
  let bytes = Y.encodeStateAsUpdate(project.doc).byteLength;
  let assetCount = 0;
  if (includeAudio) {
    for (const hash of project.assets.keys()) {
      const local = await assetStore.get(hash);
      if (local) {
        bytes += local.byteLength;
        assetCount += 1;
      }
    }
  }
  return { bytes, assetCount };
}

export interface ParsedBundle {
  manifest: BundleManifest | null;
  projectBytes: Uint8Array;
  assets: Map<string, Uint8Array>;
}

/// Inverse of buildBundle — used by import (M7c). Tolerates a missing
/// manifest (older / hand-made bundles) as long as project.yjs is
/// present.
export function parseBundle(zip: Uint8Array): ParsedBundle {
  const files = unzipSync(zip);
  const projectBytes = files[PROJECT_ENTRY];
  if (!projectBytes) {
    throw new Error(`bundle is missing ${PROJECT_ENTRY}`);
  }
  let manifest: BundleManifest | null = null;
  if (files[MANIFEST_ENTRY]) {
    try {
      manifest = JSON.parse(strFromU8(files[MANIFEST_ENTRY])) as BundleManifest;
    } catch {
      manifest = null;
    }
  }
  const assets = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    const m = /^assets\/([0-9a-f]+)\.bin$/.exec(path);
    if (m) assets.set(m[1], bytes);
  }
  return { manifest, projectBytes, assets };
}

/// Browser download of in-memory bytes via a transient object URL.
export function triggerDownload(
  filename: string,
  bytes: Uint8Array,
  mime = 'application/zip',
): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/// 1234567 → "1.2 MB". Mirrors the readout in the export panel.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
