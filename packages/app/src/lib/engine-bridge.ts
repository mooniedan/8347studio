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
const EV_SET_PARAM = 8;
const EV_NOTE_ON = 9;
const EV_NOTE_OFF = 10;
const EV_MIDI_CC = 11;
const EV_ALL_NOTES_OFF = 12;

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

export function encodeSetParam(track: number, id: number, value: number): Uint8Array {
  return concat([
    new Uint8Array([EV_SET_PARAM]),
    u32VarintToBytes(track),
    u32VarintToBytes(id),
    f32ToBytes(value),
  ]);
}

export function encodeNoteOn(track: number, pitch: number, velocity: number): Uint8Array {
  return concat([
    new Uint8Array([EV_NOTE_ON]),
    u32VarintToBytes(track),
    new Uint8Array([pitch & 0x7f, velocity & 0x7f]),
  ]);
}

export function encodeNoteOff(track: number, pitch: number): Uint8Array {
  return concat([
    new Uint8Array([EV_NOTE_OFF]),
    u32VarintToBytes(track),
    new Uint8Array([pitch & 0x7f]),
  ]);
}

export function encodeMidiCc(track: number, cc: number, value: number): Uint8Array {
  return concat([
    new Uint8Array([EV_MIDI_CC]),
    u32VarintToBytes(track),
    new Uint8Array([cc & 0x7f, value & 0x7f]),
  ]);
}

export function encodeAllNotesOff(track: number): Uint8Array {
  return concat([new Uint8Array([EV_ALL_NOTES_OFF]), u32VarintToBytes(track)]);
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
const INSTR_SUBTRACTIVE = 2;

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
  const pluginId = instr.get('pluginId') as string | undefined;
  const params = instr.get('params') as Y.Map<unknown> | undefined;

  if (pluginId === 'builtin:subtractive') {
    const entries: [number, number][] = [];
    if (params) {
      params.forEach((v, k) => {
        const id = parseInt(k, 10);
        if (!Number.isNaN(id) && typeof v === 'number') {
          entries.push([id, v]);
        }
      });
    }
    const parts: Uint8Array[] = [
      new Uint8Array([INSTR_SUBTRACTIVE]),
      u32VarintToBytes(entries.length),
    ];
    for (const [id, val] of entries) {
      parts.push(u32VarintToBytes(id));
      parts.push(f32ToBytes(val));
    }
    return concat(parts);
  }

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
  // Find the StepSeq clip if any.
  let stepClip: Y.Map<unknown> | null = null;
  for (const cid of clipIds.toArray()) {
    const c = project.clipById.get(cid);
    if (c?.get('kind') === 'StepSeq') {
      stepClip = c;
      break;
    }
  }
  if (!stepClip) return u32VarintToBytes(0);
  const steps = stepClip.get('steps') as Y.Array<Y.Map<unknown>> | undefined;
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

// InsertKind discriminants — must match
// crates/audio-engine/src/snapshot.rs::InsertKind. Append-only.
const INSERT_GAIN = 0;
const INSERT_EQ = 1;
const INSERT_COMPRESSOR = 2;
const INSERT_REVERB = 3;
const INSERT_DELAY = 4;

const INSERT_KIND_BY_PLUGIN_ID: Record<string, number> = {
  'builtin:gain': INSERT_GAIN,
  'builtin:eq': INSERT_EQ,
  'builtin:compressor': INSERT_COMPRESSOR,
  'builtin:reverb': INSERT_REVERB,
  'builtin:delay': INSERT_DELAY,
};

function insertBytesForTrack(track: Y.Map<unknown>): Uint8Array {
  const arr = track.get('inserts') as Y.Array<Y.Map<unknown>> | undefined;
  if (!arr || arr.length === 0) return u32VarintToBytes(0);
  // First, collect known inserts so the count we emit matches the
  // payloads (skipping unknown plugin ids without messing up the
  // varint length we already wrote).
  const known: { kind: number; entries: [number, number][]; bypass: boolean }[] = [];
  arr.forEach((slot) => {
    const pid = slot.get('pluginId') as string | undefined;
    if (!pid || !(pid in INSERT_KIND_BY_PLUGIN_ID)) return;
    const params = slot.get('params') as Y.Map<unknown> | undefined;
    const entries: [number, number][] = [];
    params?.forEach((v, k) => {
      const id = parseInt(k, 10);
      if (!Number.isNaN(id) && typeof v === 'number') entries.push([id, v]);
    });
    known.push({
      kind: INSERT_KIND_BY_PLUGIN_ID[pid],
      entries,
      bypass: Boolean(slot.get('bypass')),
    });
  });
  const parts: Uint8Array[] = [u32VarintToBytes(known.length)];
  for (const k of known) {
    parts.push(new Uint8Array([k.kind]));
    parts.push(u32VarintToBytes(k.entries.length));
    for (const [id, val] of k.entries) {
      parts.push(u32VarintToBytes(id));
      parts.push(f32ToBytes(val));
    }
    parts.push(new Uint8Array([k.bypass ? 1 : 0]));
  }
  return concat(parts);
}

function sendBytesForTrack(project: Project, track: Y.Map<unknown>): Uint8Array {
  const arr = track.get('sends') as Y.Array<Y.Map<unknown>> | undefined;
  if (!arr || arr.length === 0) return u32VarintToBytes(0);
  const trackIds = project.tracks.toArray();
  const known: { target: number; level: number; preFader: boolean }[] = [];
  arr.forEach((s) => {
    const tid = s.get('targetTrackId') as string | undefined;
    if (!tid) return;
    const idx = trackIds.indexOf(tid);
    if (idx < 0) return;
    known.push({
      target: idx,
      level: (s.get('level') as number | undefined) ?? 0,
      preFader: Boolean(s.get('preFader')),
    });
  });
  const parts: Uint8Array[] = [u32VarintToBytes(known.length)];
  for (const k of known) {
    parts.push(u32VarintToBytes(k.target));
    parts.push(f32ToBytes(k.level));
    parts.push(new Uint8Array([k.preFader ? 1 : 0]));
  }
  return concat(parts);
}

function pianoRollBytesForTrack(project: Project, track: Y.Map<unknown>): Uint8Array {
  if (track.get('kind') !== 'MIDI') {
    return u32VarintToBytes(0);
  }
  const clipIds = track.get('clips') as Y.Array<string> | undefined;
  if (!clipIds || clipIds.length === 0) {
    return u32VarintToBytes(0);
  }
  let pianoClip: Y.Map<unknown> | null = null;
  for (const cid of clipIds.toArray()) {
    const c = project.clipById.get(cid);
    if (c?.get('kind') === 'PianoRoll') {
      pianoClip = c;
      break;
    }
  }
  if (!pianoClip) return u32VarintToBytes(0);
  const notes = pianoClip.get('notes') as Y.Array<Y.Map<unknown>> | undefined;
  if (!notes || notes.length === 0) return u32VarintToBytes(0);
  const parts: Uint8Array[] = [u32VarintToBytes(notes.length)];
  for (const n of notes.toArray()) {
    const pitch = ((n.get('pitch') as number | undefined) ?? 60) & 0xff;
    const velocity = ((n.get('velocity') as number | undefined) ?? 100) & 0xff;
    const startTick = (n.get('startTick') as number | undefined) ?? 0;
    const lengthTicks = (n.get('lengthTicks') as number | undefined) ?? 0;
    parts.push(new Uint8Array([pitch, velocity]));
    parts.push(u64VarintToBytes(startTick));
    parts.push(u64VarintToBytes(lengthTicks));
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
        pianoRollBytesForTrack(project, track),
        insertBytesForTrack(track),
        sendBytesForTrack(project, track),
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
  setParam(track: number, id: number, value: number): void;
  noteOn(track: number, pitch: number, velocity: number): void;
  noteOff(track: number, pitch: number): void;
  midiCc(track: number, cc: number, value: number): void;
  allNotesOff(track: number): void;
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
      if (
        path === '' ||
        path.endsWith('instrumentSlot') ||
        path.endsWith('clips') ||
        path.includes('inserts') ||
        path.includes('sends')
      ) {
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
  // pattern. Single (non-deep) observe handles add/remove keys on
  // clipById; nested clip-content edits (step toggles, piano-roll
  // notes) flow through the deep observer below so the engine
  // snapshot reflects every Y.Doc change.
  const onClipChange = (ev: Y.YMapEvent<Y.Map<unknown>>) => {
    if (ev.changes.keys.size > 0) rebuild();
  };
  project.clipById.observe(onClipChange);
  // Deep observe — picks up note add/remove inside PianoRoll clips
  // (and step edits inside StepSeq clips, which redundantly mirror the
  // direct setStepMask path until that path retires).
  const onClipContentChange = () => rebuild();
  project.clipById.observeDeep(onClipContentChange);

  const onTempoChange = () => {
    const bpm = projectBpm(project);
    writer.write(encodeSetBpm(bpm));
  };
  project.tempoMap.observeDeep(onTempoChange);

  // Mirror master gain + per-track mixer params (gain/pan/mute/solo)
  // changes from the Y.Doc into SAB events. These are cosmetic
  // (engine state changes per-block) so they don't trigger a snapshot
  // rebuild.
  let lastMasterGain = (project.meta.get('masterGain') as number | undefined) ?? 1.0;
  const onMetaChange = () => {
    const next = (project.meta.get('masterGain') as number | undefined) ?? 1.0;
    if (next !== lastMasterGain) {
      lastMasterGain = next;
      writer.write(encodeSetMasterGain(next));
    }
  };
  project.meta.observe(onMetaChange);

  // Per-track param mirror — fires for every cosmetic edit on any
  // track. We diff against last-known state so unrelated edits (e.g.
  // adding a clip to a track) don't cause spurious SAB writes.
  type TrackState = { gain: number; pan: number; mute: boolean; solo: boolean };
  const lastTrackState = new Map<string, TrackState>();
  const snapshotTrackState = (id: string): TrackState | null => {
    const t = project.trackById.get(id);
    if (!t) return null;
    return {
      gain: (t.get('gain') as number | undefined) ?? 1,
      pan: (t.get('pan') as number | undefined) ?? 0,
      mute: (t.get('mute') as boolean | undefined) ?? false,
      solo: (t.get('solo') as boolean | undefined) ?? false,
    };
  };
  const syncTrackParams = () => {
    for (let i = 0; i < project.tracks.length; i++) {
      const id = project.tracks.get(i);
      const next = snapshotTrackState(id);
      if (!next) continue;
      const prev = lastTrackState.get(id);
      if (!prev) {
        lastTrackState.set(id, next);
        // Initial sync — engine already builds the track from the
        // snapshot, so no extra writes needed for *this* track.
        continue;
      }
      if (next.gain !== prev.gain) writer.write(encodeSetTrackGain(i, next.gain));
      if (next.pan !== prev.pan) writer.write(encodeSetTrackPan(i, next.pan));
      if (next.mute !== prev.mute) writer.write(encodeSetTrackMute(i, next.mute));
      if (next.solo !== prev.solo) writer.write(encodeSetTrackSolo(i, next.solo));
      lastTrackState.set(id, next);
    }
  };
  project.trackById.observeDeep(syncTrackParams);
  // Seed the diff state so the first real edit produces an event.
  syncTrackParams();

  // Synth param observers — one per subtractive track. Re-attach when
  // tracks are added/removed/swapped so each observer captures the
  // current track index. (Index can shift if earlier tracks are
  // deleted; the observer resolves it lazily at fire time.)
  const synthOffs = new Map<string, () => void>();
  const reattachSynthObservers = () => {
    for (const off of synthOffs.values()) off();
    synthOffs.clear();
    for (let idx = 0; idx < project.tracks.length; idx++) {
      const trackId = project.tracks.get(idx);
      const t = project.trackById.get(trackId);
      if (!t || t.get('kind') !== 'MIDI') continue;
      const instr = t.get('instrumentSlot') as Y.Map<unknown> | undefined;
      if (!instr || instr.get('pluginId') !== 'builtin:subtractive') continue;
      const params = instr.get('params') as Y.Map<unknown> | undefined;
      if (!params) continue;
      const handler = (ev: Y.YMapEvent<unknown>) => {
        const trackIdx = project.tracks.toArray().indexOf(trackId);
        if (trackIdx < 0) return;
        ev.changes.keys.forEach((_change, key) => {
          const id = parseInt(key, 10);
          if (Number.isNaN(id)) return;
          const v = params.get(key) as number | undefined;
          if (typeof v === 'number') {
            writer.write(encodeSetParam(trackIdx, id, v));
          }
        });
      };
      params.observe(handler);
      synthOffs.set(trackId, () => params.unobserve(handler));
    }
  };
  reattachSynthObservers();
  project.tracks.observe(reattachSynthObservers);
  // Instrument swap re-shapes which tracks have synths — re-attach.
  project.trackById.observeDeep(reattachSynthObservers);

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
    setParam(track, id, value) {
      writer.write(encodeSetParam(track, id, value));
    },
    noteOn(track, pitch, velocity) {
      writer.write(encodeNoteOn(track, pitch, velocity));
    },
    noteOff(track, pitch) {
      writer.write(encodeNoteOff(track, pitch));
    },
    midiCc(track, cc, value) {
      writer.write(encodeMidiCc(track, cc, value));
    },
    allNotesOff(track) {
      writer.write(encodeAllNotesOff(track));
    },
    destroy() {
      project.tracks.unobserveDeep(onStructural);
      project.trackById.unobserveDeep(onStructural);
      project.trackById.unobserveDeep(syncTrackParams);
      project.tempoMap.unobserveDeep(onTempoChange);
      project.clipById.unobserve(onClipChange);
      project.clipById.unobserveDeep(onClipContentChange);
      project.meta.unobserve(onMetaChange);
      project.tracks.unobserve(reattachSynthObservers);
      project.trackById.unobserveDeep(reattachSynthObservers);
      for (const off of synthOffs.values()) off();
      synthOffs.clear();
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
