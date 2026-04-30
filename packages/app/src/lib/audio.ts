// Browser-side facade for the AudioWorklet that hosts the wasm engine.
//
// Exposes a singleton AudioContext + AudioWorkletNode pair, a shared
// SharedArrayBuffer for the engine-bridge SPSC ring, and the legacy
// per-step / per-bpm / per-waveform postMessage entry points used by
// the Phase-0/1 Sequencer UI. The SAB ring is the new path introduced
// in M3 — gain/pan/mute/solo/transport go through it; structural
// changes go through `rebuild` postMessages.

import { RING_TOTAL_BYTES } from './engine-bridge';

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let readyPromise: Promise<{ node: AudioWorkletNode; ring: SharedArrayBuffer }> | null = null;
let ring: SharedArrayBuffer | null = null;
let stepListener: ((step: number) => void) | null = null;
let debugCounter = 0;
const debugWaiters = new Map<number, (value: number) => void>();

export type Waveform = 'sine' | 'saw' | 'square';
const WAVEFORM_CODE: Record<Waveform, number> = { sine: 0, saw: 1, square: 2 };

function getRing(): SharedArrayBuffer {
  if (ring) return ring;
  ring = new SharedArrayBuffer(RING_TOTAL_BYTES);
  return ring;
}

export async function ensureReady(): Promise<{ node: AudioWorkletNode; ring: SharedArrayBuffer }> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/worklet/processor.js');
    const bytes = await fetch('/wasm_bridge.wasm').then((r) => r.arrayBuffer());
    node = new AudioWorkletNode(ctx, 'daw-processor', { outputChannelCount: [2] });
    const sab = getRing();
    const ready = new Promise<void>((resolve) => {
      const onMessage = (e: MessageEvent) => {
        const data = e.data;
        if (data?.type === 'ready') {
          resolve();
        } else if (data?.type === 'step') {
          stepListener?.(data.step);
        } else if (data?.type === 'debug-reply') {
          const cb = debugWaiters.get(data.id);
          if (cb) {
            debugWaiters.delete(data.id);
            cb(data.value);
          }
        }
      };
      node!.port.onmessage = onMessage;
    });
    node.port.postMessage({ type: 'init', bytes, ring: sab }, [bytes]);
    await ready;
    node.connect(ctx.destination);
    return { node: node!, ring: sab };
  })();
  return readyPromise;
}

export function onStep(fn: (step: number) => void): void {
  stepListener = fn;
}

export async function play(): Promise<void> {
  await ensureReady();
  if (ctx!.state === 'suspended') await ctx!.resume();
  node!.port.postMessage({ type: 'setPlaying', on: true });
}

export async function stop(): Promise<void> {
  if (!node) return;
  node.port.postMessage({ type: 'setPlaying', on: false });
}

export async function setStepMask(track: number, i: number, mask: number): Promise<void> {
  await ensureReady();
  node!.port.postMessage({ type: 'setStepMask', track, i, mask });
}

export async function setWaveform(track: number, w: Waveform): Promise<void> {
  await ensureReady();
  node!.port.postMessage({ type: 'setWaveform', track, w: WAVEFORM_CODE[w] });
}

/// Test-only: ask the worklet to read a debug export from the wasm engine.
export async function debugRead(
  what: 'trackGain' | 'masterGain' | 'trackCount' | 'currentTick' | 'bpm',
  track = 0,
): Promise<number> {
  await ensureReady();
  return new Promise((resolve) => {
    const id = ++debugCounter;
    debugWaiters.set(id, resolve);
    node!.port.postMessage({ type: 'debug', id, what, track });
  });
}

/// Post a rebuild snapshot directly. Used by engine-bridge.attachBridge.
export async function postRebuild(bytes: Uint8Array): Promise<void> {
  await ensureReady();
  node!.port.postMessage({ type: 'rebuild', bytes }, [bytes.buffer]);
}
