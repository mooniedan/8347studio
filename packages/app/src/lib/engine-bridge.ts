// Hybrid engine bridge.
//
// Two channels carry state from the main thread to the AudioWorklet:
//
// 1. Structural changes (track add/remove, instrument swap, voice count
//    change) flow through `RebuildProject` postMessages — postcard-encoded
//    snapshots that the engine swaps in atomically between audio blocks.
//
// 2. Cosmetic / runtime changes (gain, pan, mute, solo, transport) flow
//    through a SPSC SharedArrayBuffer ring. The audio thread drains it at
//    the start of every block.
//
// Wire formats are pinned by `crates/audio-engine/src/snapshot.rs` and
// `crates/audio-engine/src/event.rs`. Any divergence here is a bug.

import * as Y from 'yjs';
import {
  getFirstStepSeqClip,
  type Project,
  type Waveform,
} from './project';

// ---- SAB ring layout (mirrors crates/audio-engine/src/sab_ring.rs) -----

export const HEADER_BYTES = 8;
export const HEAD_OFFSET = 0;
export const TAIL_OFFSET = 4;
export const DATA_OFFSET = HEADER_BYTES;

/// 64 KiB data region (power of two), per phase-1 plan M3.
export const RING_DATA_CAPACITY = 64 * 1024;
export const RING_TOTAL_BYTES = HEADER_BYTES + RING_DATA_CAPACITY;

const LEN_PREFIX_BYTES = 4;

// ---- postcard event encoding (mirrors event.rs) ------------------------
//
// `Event` is a tagged enum. postcard encodes the variant index as a
// varint (single byte for indices < 128), followed by the payload in
// declaration order.

const EV_TRANSPORT = 0;
const EV_SET_TRACK_GAIN = 1;
const EV_SET_TRACK_PAN = 2;
const EV_SET_TRACK_MUTE = 3;
const EV_SET_TRACK_SOLO = 4;
const EV_SET_MASTER_GAIN = 5;
const EV_SET_BPM = 6;
const EV_LOCATE = 7;

function f32ToBytes(v: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, v, true);
  return new Uint8Array(buf);
}

function u32VarintToBytes(v: number): Uint8Array {
  // postcard uses varint for u32 (max 5 bytes). For our use (track index
  // 0..65535), one or two bytes is plenty.
  const out: number[] = [];
  let n = v >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n & 0x7f);
  return new Uint8Array(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function encodeTransport(play: boolean): Uint8Array {
  return concat([new Uint8Array([EV_TRANSPORT, play ? 1 : 0])]);
}

export function encodeSetTrackGain(track: number, gain: number): Uint8Array {
  return concat([new Uint8Array([EV_SET_TRACK_GAIN]), u32VarintToBytes(track), f32ToBytes(gain)]);
}

export function encodeSetTrackPan(track: number, pan: number): Uint8Array {
  return concat([new Uint8Array([EV_SET_TRACK_PAN]), u32VarintToBytes(track), f32ToBytes(pan)]);
}

export function encodeSetTrackMute(track: number, mute: boolean): Uint8Array {
  return concat([new Uint8Array([EV_SET_TRACK_MUTE]), u32VarintToBytes(track), new Uint8Array([mute ? 1 : 0])]);
}

export function encodeSetTrackSolo(track: number, solo: boolean): Uint8Array {
  return concat([new Uint8Array([EV_SET_TRACK_SOLO]), u32VarintToBytes(track), new Uint8Array([solo ? 1 : 0])]);
}

export function encodeSetMasterGain(gain: number): Uint8Array {
  return concat([new Uint8Array([EV_SET_MASTER_GAIN]), f32ToBytes(gain)]);
}

export function encodeSetBpm(bpm: number): Uint8Array {
  return concat([new Uint8Array([EV_SET_BPM]), f32ToBytes(bpm)]);
}

function u64LeBytes(v: number): Uint8Array {
  // Phase-1 ticks fit in 32 bits, but the wire format is u64 LE.
  // postcard encodes u64 as a varint, NOT raw — match that.
  return u64VarintToBytes(v);
}

function u64VarintToBytes(v: number): Uint8Array {
  const out: number[] = [];
  // JS can represent integers up to 2^53; for tick values this is plenty.
  let n = Math.max(0, Math.floor(v));
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return new Uint8Array(out);
}

export function encodeLocate(tick: number): Uint8Array {
  return concat([new Uint8Array([EV_LOCATE]), u64LeBytes(tick)]);
}

// ---- Ring writer -------------------------------------------------------

export class RingWriter {
  private head: Int32Array;
  private tail: Int32Array;
  private data: Uint8Array;
  private mask: number;

  constructor(sab: SharedArrayBuffer) {
    if (sab.byteLength < HEADER_BYTES + 4) {
      throw new Error(`ring SAB too small: ${sab.byteLength}`);
    }
    const cap = sab.byteLength - HEADER_BYTES;
    if ((cap & (cap - 1)) !== 0) {
      throw new Error(`ring data region must be power of 2; got ${cap}`);
    }
    this.head = new Int32Array(sab, HEAD_OFFSET, 1);
    this.tail = new Int32Array(sab, TAIL_OFFSET, 1);
    this.data = new Uint8Array(sab, DATA_OFFSET, cap);
    this.mask = cap - 1;
  }

  /// Write a single event payload into the ring. Returns false if there
  /// isn't space (caller may drop or retry next tick).
  write(payload: Uint8Array): boolean {
    const cap = this.data.length;
    const head = Atomics.load(this.head, 0) >>> 0;
    const tail = Atomics.load(this.tail, 0) >>> 0;
    const used = (head - tail) >>> 0;
    const total = LEN_PREFIX_BYTES + payload.length;
    if (used + total > cap) return false;

    // Length prefix (LE u32).
    for (let i = 0; i < 4; i++) {
      this.data[(head + i) & this.mask] = (payload.length >>> (i * 8)) & 0xff;
    }
    // Payload.
    for (let i = 0; i < payload.length; i++) {
      this.data[(head + LEN_PREFIX_BYTES + i) & this.mask] = payload[i];
    }
    // Publish: release-store head.
    Atomics.store(this.head, 0, (head + total) >>> 0);
    return true;
  }
}

// ---- Snapshot builder (mirrors snapshot.rs) ---------------------------

export interface SnapshotEnvelope {
  bytes: Uint8Array;
}

const TK_MIDI = 0;
const TK_AUDIO = 1;
const TK_BUS = 2;

const INSTR_BUILTIN_SEQ = 0;
const INSTR_NONE = 1;

function encodeString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  return concat([u32VarintToBytes(utf8.length), utf8]);
}

function trackKindFromYjs(kind: unknown): number {
  if (kind === 'Audio') return TK_AUDIO;
  if (kind === 'Bus') return TK_BUS;
  return TK_MIDI;
}

function instrumentSnapshotBytes(track: Y.Map<unknown>): Uint8Array {
  const kind = track.get('kind');
  if (kind !== 'MIDI') {
    return new Uint8Array([INSTR_NONE]);
  }
  const instr = track.get('instrumentSlot') as Y.Map<unknown> | undefined;
  if (!instr) return new Uint8Array([INSTR_NONE]);
  const params = instr.get('params') as Y.Map<unknown> | undefined;
  const w = params?.get('waveform');
  const code = w === 'saw' ? 1 : w === 'square' ? 2 : 0;
  return concat([new Uint8Array([INSTR_BUILTIN_SEQ]), u32VarintToBytes(code)]);
}

function stepBytesForTrack(project: Project, track: Y.Map<unknown>): Uint8Array {
  if (track.get('kind') !== 'MIDI') {
    return u32VarintToBytes(0);
  }
  const clipIds = track.get('clips') as Y.Array<string> | undefined;
  if (!clipIds || clipIds.length === 0) {
    return u32VarintToBytes(0);
  }
  const clipId = clipIds.get(0);
  const clip = project.clipById.get(clipId);
  if (!clip || clip.get('kind') !== 'StepSeq') {
    return u32VarintToBytes(0);
  }
  const steps = clip.get('steps') as Y.Array<Y.Map<unknown>> | undefined;
  if (!steps) return u32VarintToBytes(0);
  const masks: number[] = [];
  for (const cell of steps.toArray()) {
    masks.push(((cell.get('notes') as number) ?? 0) >>> 0);
  }
  const parts: Uint8Array[] = [u32VarintToBytes(masks.length)];
  for (const m of masks) {
    parts.push(u32VarintToBytes(m));
  }
  return concat(parts);
}

export function buildSnapshot(project: Project): Uint8Array {
  const masterGain = (project.meta.get('masterGain') as number | undefined) ?? 1.0;
  const trackBytes: Uint8Array[] = [];
  for (const id of project.tracks.toArray()) {
    const track = project.trackById.get(id);
    if (!track) continue;
    const kind = trackKindFromYjs(track.get('kind'));
    const name = (track.get('name') as string | undefined) ?? '';
    const gain = (track.get('gain') as number | undefined) ?? 1.0;
    const pan = (track.get('pan') as number | undefined) ?? 0.0;
    const mute = (track.get('mute') as boolean | undefined) ?? false;
    const solo = (track.get('solo') as boolean | undefined) ?? false;
    const instr = track.get('instrumentSlot') as Y.Map<unknown> | undefined;
    const voices = (instr?.get('voices') as number | undefined) ?? 16;
    trackBytes.push(
      concat([
        new Uint8Array([kind]),
        encodeString(name),
        f32ToBytes(gain),
        f32ToBytes(pan),
        new Uint8Array([mute ? 1 : 0, solo ? 1 : 0]),
        u32VarintToBytes(voices),
        instrumentSnapshotBytes(track),
        stepBytesForTrack(project, track),
      ]),
    );
  }
  return concat([f32ToBytes(masterGain), u32VarintToBytes(trackBytes.length), ...trackBytes]);
}

// ---- Public bridge API used by App.svelte -----------------------------

export interface Bridge {
  /// Build the latest snapshot and post it to the worklet.
  rebuild(): void;
  /// Send a SetTrackGain event via SAB.
  setTrackGain(track: number, gain: number): void;
  setTrackPan(track: number, pan: number): void;
  setTrackMute(track: number, mute: boolean): void;
  setTrackSolo(track: number, solo: boolean): void;
  setMasterGain(gain: number): void;
  setTransport(playing: boolean): void;
  setBpm(bpm: number): void;
  locate(tick: number): void;
  destroy(): void;
}

export interface BridgeHost {
  ring: SharedArrayBuffer;
  postRebuild: (bytes: Uint8Array) => void;
}

export function attachBridge(project: Project, host: BridgeHost): Bridge {
  const writer = new RingWriter(host.ring);

  const rebuild = () => {
    host.postRebuild(buildSnapshot(project));
  };

  // Auto-rebuild when track structure changes (track count, instrument
  // swap, voice count). We keep this coarse: any deep change to tracks
  // or trackById triggers a snapshot rebuild. Per-param tweaks already
  // route via SAB, so the rebuild rate stays low.
  const onStructural = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    let needs = false;
    for (const ev of events) {
      const path = ev.path.join('/');
      if (path === '' || path.endsWith('instrumentSlot') || path.endsWith('clips')) {
        needs = true;
        break;
      }
      const change = ev.changes.keys;
      for (const [k] of change) {
        if (k === 'voices' || k === 'kind') {
          needs = true;
          break;
        }
      }
      if (needs) break;
    }
    if (needs) rebuild();
  };
  project.tracks.observeDeep(onStructural);
  project.trackById.observeDeep(onStructural);
  // Clip add/remove triggers a rebuild so the engine sees the new step
  // pattern. Single (non-deep) observe — we only care about key adds /
  // deletes on clipById, not nested edits (those go via the track's
  // clip.observeDeep inside Sequencer.svelte).
  const onClipChange = (ev: Y.YMapEvent<Y.Map<unknown>>) => {
    if (ev.changes.keys.size > 0) rebuild();
  };
  project.clipById.observe(onClipChange);

  const onTempoChange = () => {
    const bpm = projectBpm(project);
    writer.write(encodeSetBpm(bpm));
  };
  project.tempoMap.observeDeep(onTempoChange);

  // Initial sync.
  rebuild();
  onTempoChange();

  return {
    rebuild,
    setTrackGain(track, gain) {
      writer.write(encodeSetTrackGain(track, gain));
    },
    setTrackPan(track, pan) {
      writer.write(encodeSetTrackPan(track, pan));
    },
    setTrackMute(track, mute) {
      writer.write(encodeSetTrackMute(track, mute));
    },
    setTrackSolo(track, solo) {
      writer.write(encodeSetTrackSolo(track, solo));
    },
    setMasterGain(gain) {
      writer.write(encodeSetMasterGain(gain));
    },
    setTransport(playing) {
      writer.write(encodeTransport(playing));
    },
    setBpm(bpm) {
      writer.write(encodeSetBpm(bpm));
    },
    locate(tick) {
      writer.write(encodeLocate(tick));
    },
    destroy() {
      project.tracks.unobserveDeep(onStructural);
      project.trackById.unobserveDeep(onStructural);
      project.tempoMap.unobserveDeep(onTempoChange);
      project.clipById.unobserve(onClipChange);
    },
  };
}

// Convenience: read the BPM out of the project (used by Sequencer for
// its direct postMessage path until M4 migrates BPM through the SAB).
export function projectBpm(project: Project): number {
  const seg = project.tempoMap.length > 0 ? project.tempoMap.get(0) : null;
  return seg?.bpm ?? 120;
}

// Convenience: derive the current step-seq clip's first track waveform.
export function projectWaveform(project: Project): Waveform {
  const trackId = project.tracks.length > 0 ? project.tracks.get(0) : null;
  if (!trackId) return 'sine';
  const track = project.trackById.get(trackId);
  const instr = track?.get('instrumentSlot') as Y.Map<unknown> | undefined;
  const params = instr?.get('params') as Y.Map<unknown> | undefined;
  const w = params?.get('waveform');
  return w === 'saw' || w === 'square' ? w : 'sine';
}

// Re-export so App.svelte can tell what step grid to bind to without
// importing two modules.
export { getFirstStepSeqClip };
