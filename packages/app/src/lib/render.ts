// Phase-10 M7d — render-to-audio orchestration.
//
// Builds the engine snapshot + asset PCM on the main thread, fetches
// the engine WASM, hands it all to the render worker, and encodes the
// returned stereo PCM into a WAV. Rendering by target tick (the worker
// renders until the engine reaches `endTick`) keeps tempo→sample math
// inside the engine.

import {
  getLoopRegion,
  getAudioRegions,
  listBlocksForTrack,
  getBpm,
  PPQ,
  type Project,
} from './project';
import { buildSnapshot, collectRenderAssets } from './engine-bridge';
import { encodeWavInterleaved, type BitDepth } from './wav';
import RenderWorker from './render-worker.ts?worker';

export type RenderRange = 'loop' | 'project';

export interface RenderOptions {
  sampleRate: number;
  bitDepth: BitDepth;
  range: RenderRange;
  /// Extra decay rendered past the content end (reverb/release tails).
  tailSeconds?: number;
}

export interface RenderResult {
  wav: Uint8Array;
  frames: number;
  seconds: number;
}

/// Furthest tick the render should reach. Loop range = the loop's end;
/// project range = the max of the loop end and every audio region's
/// end. Falls back to one bar so an empty project still renders.
export function renderEndTick(project: Project, range: RenderRange): number {
  const loop = getLoopRegion(project);
  if (range === 'loop' && loop) return loop.endTick;
  let end = loop?.endTick ?? 0;
  for (let t = 0; t < project.tracks.length; t++) {
    for (const r of getAudioRegions(project, t)) {
      end = Math.max(end, r.startTick + r.lengthTicks);
    }
    // Phase-12 — span the arrangement so 'project' render reaches every
    // placed block (blocks postdate the original audio-region-only end).
    for (const b of listBlocksForTrack(project, t)) {
      end = Math.max(end, b.startTick + b.lengthTicks);
    }
  }
  return end > 0 ? end : PPQ * 4;
}

/// Seconds a tick span occupies at the project's (first-segment) tempo.
/// Used for the dry-run readout; the actual length comes back exact
/// from the worker.
export function ticksToSeconds(project: Project, ticks: number): number {
  const bpm = getBpm(project);
  return (ticks / PPQ) * (60 / bpm);
}

export async function renderProjectToWav(
  project: Project,
  opts: RenderOptions,
): Promise<RenderResult> {
  const snapshot = buildSnapshot(project);
  const assets = await collectRenderAssets(project);
  const wasmBytes = await (await fetch('/wasm_bridge.wasm')).arrayBuffer();

  const tail = opts.tailSeconds ?? 0;
  const contentTicks = renderEndTick(project, opts.range);
  const tailTicks = tail > 0 ? (tail * getBpm(project) * PPQ) / 60 : 0;
  const endTick = contentTicks + tailTicks;
  // Generous cap so a runaway render can't allocate unbounded memory.
  const maxFrames = Math.ceil((ticksToSeconds(project, endTick) + 1) * opts.sampleRate);

  const pcm = await runWorker({
    wasmBytes,
    snapshot,
    assets,
    sampleRate: opts.sampleRate,
    endTick,
    maxFrames,
  });

  const wav = encodeWavInterleaved(pcm, 2, opts.sampleRate, opts.bitDepth);
  return { wav, frames: pcm.length / 2, seconds: pcm.length / 2 / opts.sampleRate };
}

interface WorkerJob {
  wasmBytes: ArrayBuffer;
  snapshot: Uint8Array;
  assets: { id: number; pcm: Float32Array }[];
  sampleRate: number;
  endTick: number;
  maxFrames: number;
}

function runWorker(job: WorkerJob): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const worker = new RenderWorker();
    worker.onmessage = (e: MessageEvent) => {
      worker.terminate();
      if (e.data?.ok) resolve(e.data.pcm as Float32Array);
      else reject(new Error(e.data?.error ?? 'render failed'));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    // wasmBytes is safe to transfer (freshly fetched); snapshot + asset
    // PCM are NOT transferred — the PCM is shared with the decode cache.
    worker.postMessage(job, [job.wasmBytes]);
  });
}
