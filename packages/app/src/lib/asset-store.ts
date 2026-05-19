// Phase-5 M2: OPFS-backed content-addressed asset store.
//
// Original encoded audio files (WAV / FLAC / MP3 / OGG) live in OPFS
// under `<sha256>.bin`. The Y.Doc only references assets by hash and
// stores metadata (channels, sampleRate, frames, sourceFilename) —
// never PCM. Decoded PCM is held in a per-session in-memory cache so
// repeated playback doesn't re-decode.
//
// This module is browser-only; the worklet doesn't touch it directly
// (the engine's PCM cache is populated via postMessage register_asset
// — see engine-bridge.ts).
//
// Phase-9 M2: when a remote asset store is configured, `putBytes`
// fires-and-forgets an upload to the bucket and `ensureLocal` will
// download a hash from the bucket into OPFS on demand.

import { getRemoteAssetStore } from './asset-storage-remote';

const OPFS_DIR = '8347-assets';

export interface AssetMetadata {
  channels: number;
  sampleRate: number;
  frames: number;
  format?: string;
  sourceFilename?: string;
}

export interface DecodedAsset extends AssetMetadata {
  /// Mono mixdown of the source. Phase-5 ships mono-only end-to-end;
  /// stereo support is a polish item once the engine path widens.
  pcm: Float32Array;
}

const decodedCache = new Map<string, DecodedAsset>();

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  // crypto.subtle.digest takes BufferSource; cast through unknown to
  // dodge the TS-5.x SharedArrayBuffer-vs-ArrayBuffer narrowing.
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const arr = new Uint8Array(buf);
  let hex = '';
  for (const b of arr) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function putBytes(bytes: Uint8Array): Promise<string> {
  const hash = await sha256Hex(bytes);
  const folder = await dir();
  // Idempotent — if the file already exists, leave it.
  let exists = false;
  try {
    await folder.getFileHandle(`${hash}.bin`);
    exists = true;
  } catch {
    /* not found */
  }
  if (!exists) {
    const handle = await folder.getFileHandle(`${hash}.bin`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as FileSystemWriteChunkType);
    await writable.close();
  }
  // Phase-9 M2 — fire-and-forget cloud upload. Failures are
  // non-fatal: the asset still plays locally, just not on a peer's
  // machine. A future polish pass surfaces "upload pending" status
  // in the UI; today we log and move on.
  const remote = getRemoteAssetStore();
  if (remote) {
    void remote
      .upload(hash, bytes)
      .catch((err) => console.warn('asset upload', hash, err));
  }
  return hash;
}

/// Ensure an asset is in OPFS. Used on project load to pull down
/// hashes that exist in the room's Y.Doc but never landed locally
/// (e.g. peer B opens a room after peer A recorded into it).
/// Returns true when the asset is available afterwards.
export async function ensureLocal(hash: string): Promise<boolean> {
  if (await has(hash)) return true;
  const remote = getRemoteAssetStore();
  if (!remote) return false;
  try {
    const bytes = await remote.download(hash);
    if (!bytes) return false;
    // Skip the upload-side-effect path in putBytes — the bytes
    // came FROM the bucket, no need to round-trip.
    const folder = await dir();
    const handle = await folder.getFileHandle(`${hash}.bin`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as FileSystemWriteChunkType);
    await writable.close();
    return true;
  } catch (err) {
    console.warn('asset download', hash, err);
    return false;
  }
}

export async function has(hash: string): Promise<boolean> {
  try {
    const folder = await dir();
    await folder.getFileHandle(`${hash}.bin`);
    return true;
  } catch {
    return false;
  }
}

export async function get(hash: string): Promise<Uint8Array | null> {
  try {
    const folder = await dir();
    const handle = await folder.getFileHandle(`${hash}.bin`);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function list(): Promise<string[]> {
  const folder = await dir();
  const out: string[] = [];
  // FileSystemDirectoryHandle is async-iterable in modern browsers.
  // Cast through unknown to keep the type-checker happy without
  // pulling in a library.d.ts patch.
  const iterable = folder as unknown as AsyncIterable<[string, FileSystemHandle]>;
  for await (const [name] of iterable) {
    if (name.endsWith('.bin')) {
      out.push(name.slice(0, -'.bin'.length));
    }
  }
  return out;
}

/// Decode a stored asset and cache the PCM mixdown.
export async function decode(hash: string, ctx: AudioContext): Promise<DecodedAsset> {
  const cached = decodedCache.get(hash);
  if (cached) return cached;
  const bytes = await get(hash);
  if (!bytes) throw new Error(`asset ${hash} not in OPFS`);
  // decodeAudioData consumes the buffer; slice into a fresh
  // ArrayBuffer to drop the SharedArrayBuffer typing.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const buffer = await ctx.decodeAudioData(ab);
  // Mono mixdown.
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const mono = new Float32Array(frames);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < frames; i++) mono[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < frames; i++) mono[i] /= channels;
  }
  const decoded: DecodedAsset = {
    channels,
    sampleRate: buffer.sampleRate,
    frames,
    pcm: mono,
  };
  decodedCache.set(hash, decoded);
  return decoded;
}

export function clearDecodedCache(): void {
  decodedCache.clear();
}
