/**
 * Phase 8 M3a — JS plugin loader.
 *
 * Given a `PluginManifest`, fetch the plugin's `.wasm`, verify the SRI
 * integrity hash, instantiate it inside this JS context, and return a
 * typed `LoadedPlugin` handle for the engine bridge (M3b) and the
 * picker UI (M5) to drive. The loader itself runs on the main thread
 * during M3a — the worklet-side hookup is the next milestone.
 *
 * Plugin instances live in their own `WebAssembly.Memory`. The loader
 * pre-allocates input + output buffers inside that memory via the
 * plugin's `alloc(size)` export; subsequent `process()` calls copy
 * audio in via `Float32Array` views and read it back from the same
 * views.
 */

import type { PluginManifest } from './plugin-manifest';

/** Exports a third-party plugin WASM must provide. The ABI is locked
 *  in `examples/README.md`. */
interface PluginExports {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
  init: (sampleRate: number, maxBlockSize: number) => number;
  destroy: (handle: number) => void;
  set_param: (handle: number, id: number, value: number) => void;
  get_param: (handle: number, id: number) => number;
  handle_event: (handle: number, kind: number, p1: number, p2: number) => void;
  process: (
    handle: number,
    inPtr: number, inChannels: number,
    outPtr: number, outChannels: number,
    frames: number,
  ) => void;
}

/** Event-kind discriminant — matches the ABI doc and the engine's
 *  `PluginEvent` enum order. */
export const PluginEventKind = {
  NoteOn: 0,
  NoteOff: 1,
  MidiCc: 2,
  AllNotesOff: 3,
} as const;

export interface LoadOptions {
  /** Maximum audio block size the plugin will be asked to render.
   *  Determines the size of the I/O buffers the loader allocates
   *  inside the plugin's memory. */
  maxBlockSize?: number;
  /** Sample rate the plugin should target. Matches the audio context. */
  sampleRate?: number;
  /** Number of input + output channels in this plugin's I/O buffers.
   *  Defaults to stereo for both; instrument plugins typically get
   *  `inChannels = 0`. */
  inChannels?: number;
  outChannels?: number;
  /** Override the fetch implementation — primarily for tests that
   *  want to inject the WASM bytes directly. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  init(): void;
  destroy(): void;
  setParam(numericId: number, value: number): void;
  getParam(numericId: number): number;
  fireEvent(kind: number, p1?: number, p2?: number): void;
  /** Render `frames` samples. `inputs` is one Float32Array per input
   *  channel (length ≥ frames); `outputs` is filled in place, one
   *  Float32Array per output channel. */
  process(inputs: Float32Array[], outputs: Float32Array[], frames: number): void;
}

export class IntegrityError extends Error {
  constructor(public readonly expected: string, public readonly got: string) {
    super(`integrity mismatch: expected ${expected}, got ${got}`);
    this.name = 'IntegrityError';
  }
}

export async function loadPlugin(
  manifest: PluginManifest,
  opts: LoadOptions = {},
): Promise<LoadedPlugin> {
  // Defaults are conservative. The AudioWorklet renders 128-frame
  // blocks; 512 leaves headroom for over-render. inChannels = 0
  // matches the instrument-style call shape — effects override.
  const maxBlockSize = opts.maxBlockSize ?? 512;
  const sampleRate = opts.sampleRate ?? 48_000;
  const inChannels = opts.inChannels ?? 0;
  const outChannels = opts.outChannels ?? 2;

  // 1. Fetch the WASM bytes. Tests inject via `fetchBytes`.
  const bytes = opts.fetchBytes
    ? await opts.fetchBytes(manifest.wasm)
    : await fetchWasm(manifest.wasm);

  // 2. Verify integrity. SRI sha256 format: `sha256-<base64>`.
  const digest = await sha256(bytes);
  const expected = manifest.wasmIntegrity;
  const got = `sha256-${digest}`;
  if (expected !== got) {
    throw new IntegrityError(expected, got);
  }

  // 3. Instantiate. M3a passes no imports — plugins are pure
  // function modules; M3b adds a small host-imports surface.
  // Compile first so TS picks the (Module, imports) overload rather
  // than choking on the BufferSource overload's strict typing.
  const module = await WebAssembly.compile(toAb(bytes));
  const instance = await WebAssembly.instantiate(module, {});
  const exp = instance.exports as unknown as PluginExports;

  let handle = 0;
  let inPtr = 0;
  let outPtr = 0;
  let inView = new Float32Array(0);
  let outView = new Float32Array(0);

  function refreshViews() {
    // Each grow of WebAssembly.Memory invalidates existing views.
    // The bump allocator in the reference plugin never grows, but
    // a real plugin's allocator might; rebuilding the views on
    // every process is cheap (it's just an ArrayBuffer view).
    if (!handle) return;
    const buf = exp.memory.buffer;
    inView = new Float32Array(buf, inPtr, maxBlockSize * inChannels);
    outView = new Float32Array(buf, outPtr, maxBlockSize * outChannels);
  }

  return {
    manifest,
    init() {
      if (handle) return;
      handle = exp.init(sampleRate, maxBlockSize);
      if (handle === 0) throw new Error('plugin init returned null handle');
      inPtr = inChannels > 0 ? exp.alloc(maxBlockSize * inChannels * 4) : 0;
      outPtr = exp.alloc(maxBlockSize * outChannels * 4);
      refreshViews();
    },
    destroy() {
      if (!handle) return;
      exp.destroy(handle);
      handle = 0;
    },
    setParam(numericId, value) {
      if (!handle) return;
      exp.set_param(handle, numericId, value);
    },
    getParam(numericId) {
      if (!handle) return 0;
      return exp.get_param(handle, numericId);
    },
    fireEvent(kind, p1 = 0, p2 = 0) {
      if (!handle) return;
      exp.handle_event(handle, kind, p1, p2);
    },
    process(inputs, outputs, frames) {
      if (!handle) return;
      if (frames > maxBlockSize) {
        throw new Error(`frames ${frames} > maxBlockSize ${maxBlockSize}`);
      }
      // Copy inputs into the plugin's memory (interleaved by channel).
      refreshViews();
      if (inChannels > 0) {
        for (let i = 0; i < frames; i++) {
          for (let c = 0; c < inChannels; c++) {
            inView[i * inChannels + c] = inputs[c]?.[i] ?? 0;
          }
        }
      }
      exp.process(handle, inPtr, inChannels, outPtr, outChannels, frames);
      // De-interleave outputs back into the caller's arrays.
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < outChannels; c++) {
          if (outputs[c]) outputs[c][i] = outView[i * outChannels + c];
        }
      }
    },
  };
}

function toAb(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

async function fetchWasm(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch ${url}: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

/** Compute the sha256 of a byte buffer as base64 — matching the
 *  Subresource Integrity hash format the manifest uses. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer view — crypto.subtle.digest's
  // strict BufferSource typing rejects Uint8Array<SharedArrayBuffer>,
  // and we don't care which the caller supplied.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', ab);
  return base64(new Uint8Array(digest));
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
