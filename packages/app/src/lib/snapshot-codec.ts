// Phase-10 follow-up — schema-walked snapshot encoder.
//
// Replaces the 13 hand-rolled `*BytesForTrack` helpers that lived in
// engine-bridge.ts. Each helper was a separate site where adding a
// field to a Rust struct could silently drop bytes from the wire
// (the Phase-10 M1 `step_velocities` early-return bug was the
// canonical example). With a declarative schema the encoder always
// walks every field of a struct in declaration order, so missing
// fields can only happen if the schema below diverges from
// crates/audio-engine/src/snapshot.rs — and that divergence is a
// single edit visible in one place rather than scattered.
//
// The schema mirrors postcard's wire format:
//   - bool: 1 byte (0/1)
//   - u8: 1 byte
//   - u32 / u64: varint (LEB128, 7-bit groups, MSB=continuation)
//   - f32: 4 LE bytes
//   - String: varint(byte length) + utf-8 bytes
//   - Vec<T>: varint(len) + len × encoded(T)
//   - Struct: fields in declaration order, no separator
//   - Enum: varint(variant index) + variant payload (no tag length)
//   - Option<T>: 1-byte tag (0/1), Some followed by T
//
// **WHEN YOU ADD A FIELD** to a snapshot struct in `snapshot.rs`:
//   1. Append it to the matching `*_SCHEMA` below in the same order
//      as the struct declaration.
//   2. Add it to the corresponding TypeScript interface.
//   3. Make the extractor in `engine-bridge.ts` populate it.
// The Playwright suite + the cargo `apply_snapshot` tests will
// detect any divergence as decode failures.

// ─── primitive encoders ────────────────────────────────────────────

export function u32Varint(v: number): Uint8Array {
  const bytes: number[] = [];
  let n = v >>> 0;
  while (true) {
    const lo = n & 0x7f;
    n >>>= 7;
    if (n === 0) { bytes.push(lo); break; }
    bytes.push(lo | 0x80);
  }
  return new Uint8Array(bytes);
}

/// u64 varint — same as u32 but uses BigInt internally so values
/// larger than 2^32 round-trip without truncation. The Y.Doc tick
/// numbers can reach 2^53 ish; this keeps headroom.
export function u64Varint(v: number): Uint8Array {
  const bytes: number[] = [];
  let n = BigInt(v);
  if (n < 0n) n = 0n;
  while (true) {
    const lo = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) { bytes.push(lo); break; }
    bytes.push(lo | 0x80);
  }
  return new Uint8Array(bytes);
}

export function f32(v: number): Uint8Array {
  const ab = new ArrayBuffer(4);
  new DataView(ab).setFloat32(0, v, true);
  return new Uint8Array(ab);
}

const utf8 = new TextEncoder();
export function stringBytes(s: string): Uint8Array {
  const body = utf8.encode(s);
  return concat([u32Varint(body.byteLength), body]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

// ─── schema ADT ────────────────────────────────────────────────────

export type Schema =
  | { t: 'bool' }
  | { t: 'u8' }
  | { t: 'u32v' }
  | { t: 'u64v' }
  | { t: 'f32' }
  | { t: 'string' }
  | { t: 'vec'; of: Schema }
  | { t: 'option'; of: Schema }
  | { t: 'tuple'; items: Schema[] }
  | { t: 'struct'; fields: [string, Schema][] }
  | { t: 'enum'; variants: { name: string; payload: Schema | null }[] };

export const Bool: Schema = { t: 'bool' };
export const U8: Schema = { t: 'u8' };
export const U32V: Schema = { t: 'u32v' };
export const U64V: Schema = { t: 'u64v' };
export const F32: Schema = { t: 'f32' };
export const Str: Schema = { t: 'string' };
export const vec = (of: Schema): Schema => ({ t: 'vec', of });
export const option = (of: Schema): Schema => ({ t: 'option', of });
export const tuple = (...items: Schema[]): Schema => ({ t: 'tuple', items });
export const struct = (fields: [string, Schema][]): Schema => ({ t: 'struct', fields });
export const enum_ = (variants: { name: string; payload: Schema | null }[]): Schema =>
  ({ t: 'enum', variants });

// ─── snapshot types (mirror crates/audio-engine/src/snapshot.rs) ──

/// Field-order MUST match the Rust struct declarations field-for-field.
/// See the module-level comment for the rules; cross-check against
/// `snapshot.rs` when bumping either side.

export interface LoopRegion { startTick: number; endTick: number }
export const LOOP_REGION: Schema = struct([
  ['startTick', U64V],
  ['endTick', U64V],
]);

export interface AutoPoint { tick: number; value: number }
export const AUTO_POINT: Schema = struct([
  ['tick', U64V],
  ['value', F32],
]);

// AutoTarget enum — variant 0 is `Instrument` (no payload),
// variant 1 is `Insert { slot_idx: u32 }`.
export type AutoTarget =
  | { kind: 'Instrument' }
  | { kind: 'Insert'; slotIdx: number };
export const AUTO_TARGET: Schema = enum_([
  { name: 'Instrument', payload: null },
  { name: 'Insert',     payload: struct([['slotIdx', U32V]]) },
]);

export interface AutomationLane {
  trackIdx: number;
  target: AutoTarget;
  paramId: number;
  points: AutoPoint[];
}
export const AUTOMATION_LANE: Schema = struct([
  ['trackIdx', U32V],
  ['target',   AUTO_TARGET],
  ['paramId',  U32V],
  ['points',   vec(AUTO_POINT)],
]);

// TrackKind: Midi=0, Audio=1, Bus=2.
export type TrackKind = 'Midi' | 'Audio' | 'Bus';
export const TRACK_KIND: Schema = enum_([
  { name: 'Midi',  payload: null },
  { name: 'Audio', payload: null },
  { name: 'Bus',   payload: null },
]);

export type InstrumentSnapshot =
  | { kind: 'BuiltinSequencer'; waveform: number }
  | { kind: 'None' }
  | { kind: 'Subtractive'; params: [number, number][] }
  | { kind: 'Drumkit'; params: [number, number][] }
  | { kind: 'Wasm'; handle: number; isInstrument: boolean; params: [number, number][] };
export const INSTRUMENT_SNAPSHOT: Schema = enum_([
  { name: 'BuiltinSequencer', payload: struct([['waveform', U32V]]) },
  { name: 'None',             payload: null },
  { name: 'Subtractive',      payload: struct([['params', vec(tuple(U32V, F32))]]) },
  { name: 'Drumkit',          payload: struct([['params', vec(tuple(U32V, F32))]]) },
  { name: 'Wasm',             payload: struct([
    ['handle',       U32V],
    ['isInstrument', Bool],
    ['params',       vec(tuple(U32V, F32))],
  ]) },
]);

export type InsertKind =
  | { kind: 'Gain' }
  | { kind: 'Eq' }
  | { kind: 'Compressor' }
  | { kind: 'Reverb' }
  | { kind: 'Delay' }
  | { kind: 'Container' }
  | { kind: 'Wasm'; handle: number };
export const INSERT_KIND: Schema = enum_([
  { name: 'Gain',       payload: null },
  { name: 'Eq',         payload: null },
  { name: 'Compressor', payload: null },
  { name: 'Reverb',     payload: null },
  { name: 'Delay',      payload: null },
  { name: 'Container',  payload: null },
  { name: 'Wasm',       payload: struct([['handle', U32V]]) },
]);

export interface InsertSnapshot {
  kind: InsertKind;
  params: [number, number][];
  bypass: boolean;
  branches: BranchSnapshot[];
}
export interface BranchSnapshot {
  gain: number;
  inserts: InsertSnapshot[];
}
// Recursive types need lazy references — the schema is recursive too.
// We declare INSERT_SNAPSHOT_FIELDS as a getter on a single object so
// BranchSnapshot can refer back to InsertSnapshot.
const _INSERT_SNAPSHOT: Schema = {
  t: 'struct',
  get fields(): [string, Schema][] {
    return [
      ['kind',     INSERT_KIND],
      ['params',   vec(tuple(U32V, F32))],
      ['bypass',   Bool],
      ['branches', vec(BRANCH_SNAPSHOT)],
    ];
  },
} as unknown as Schema;
export const INSERT_SNAPSHOT: Schema = _INSERT_SNAPSHOT;
export const BRANCH_SNAPSHOT: Schema = struct([
  ['gain',    F32],
  ['inserts', vec(INSERT_SNAPSHOT)],
]);

export interface SendSnapshot {
  targetTrack: number;
  level: number;
  preFader: boolean;
}
export const SEND_SNAPSHOT: Schema = struct([
  ['targetTrack', U32V],
  ['level',       F32],
  ['preFader',    Bool],
]);

export interface NoteSnapshot {
  pitch: number;
  velocity: number;
  startTick: number;
  lengthTicks: number;
}
export const NOTE_SNAPSHOT: Schema = struct([
  ['pitch',       U8],
  ['velocity',    U8],
  ['startTick',   U64V],
  ['lengthTicks', U64V],
]);

export interface AudioRegionSnapshot {
  assetId: number;
  startSample: number;
  lengthSamples: number;
  assetOffsetSamples: number;
  gain: number;
  fadeInSamples: number;
  fadeOutSamples: number;
}
export const AUDIO_REGION_SNAPSHOT: Schema = struct([
  ['assetId',            U32V],
  ['startSample',        U64V],
  ['lengthSamples',      U64V],
  ['assetOffsetSamples', U64V],
  ['gain',               F32],
  ['fadeInSamples',      U32V],
  ['fadeOutSamples',     U32V],
]);

export interface TrackSnapshot {
  kind: TrackKind;
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  voices: number;
  instrument: InstrumentSnapshot;
  steps: number[];
  stepVelocities: number[];
  pianoRollNotes: NoteSnapshot[];
  inserts: InsertSnapshot[];
  sends: SendSnapshot[];
  audioRegions: AudioRegionSnapshot[];
}
export const TRACK_SNAPSHOT: Schema = struct([
  ['kind',           TRACK_KIND],
  ['name',           Str],
  ['gain',           F32],
  ['pan',            F32],
  ['mute',           Bool],
  ['solo',           Bool],
  ['voices',         U32V],
  ['instrument',     INSTRUMENT_SNAPSHOT],
  ['steps',          vec(U32V)],
  ['stepVelocities', vec(U8)],
  ['pianoRollNotes', vec(NOTE_SNAPSHOT)],
  ['inserts',        vec(INSERT_SNAPSHOT)],
  ['sends',          vec(SEND_SNAPSHOT)],
  ['audioRegions',   vec(AUDIO_REGION_SNAPSHOT)],
]);

export interface ProjectSnapshot {
  masterGain: number;
  tracks: TrackSnapshot[];
  automation: AutomationLane[];
  loopRegion: LoopRegion | null;
}
export const PROJECT_SNAPSHOT: Schema = struct([
  ['masterGain', F32],
  ['tracks',     vec(TRACK_SNAPSHOT)],
  ['automation', vec(AUTOMATION_LANE)],
  ['loopRegion', option(LOOP_REGION)],
]);

// ─── generic encoder ───────────────────────────────────────────────

export function encode(value: unknown, schema: Schema): Uint8Array {
  switch (schema.t) {
    case 'bool':
      return new Uint8Array([value ? 1 : 0]);
    case 'u8':
      return new Uint8Array([(value as number) & 0xff]);
    case 'u32v':
      return u32Varint(value as number);
    case 'u64v':
      return u64Varint(value as number);
    case 'f32':
      return f32(value as number);
    case 'string':
      return stringBytes(value as string);
    case 'vec': {
      const arr = (value as unknown[]) ?? [];
      const parts: Uint8Array[] = [u32Varint(arr.length)];
      for (const v of arr) parts.push(encode(v, schema.of));
      return concat(parts);
    }
    case 'option': {
      if (value == null) return new Uint8Array([0]);
      return concat([new Uint8Array([1]), encode(value, schema.of)]);
    }
    case 'tuple': {
      const arr = value as unknown[];
      const parts: Uint8Array[] = [];
      for (let i = 0; i < schema.items.length; i++) {
        parts.push(encode(arr[i], schema.items[i]));
      }
      return concat(parts);
    }
    case 'struct': {
      const obj = (value as Record<string, unknown>) ?? {};
      const parts: Uint8Array[] = [];
      for (const [name, fieldSchema] of schema.fields) {
        parts.push(encode(obj[name], fieldSchema));
      }
      return concat(parts);
    }
    case 'enum': {
      // Two shapes are accepted:
      //   - string literal (`'Midi'`) for unit-variant enums like
      //     TrackKind. Variant lookup uses the string directly.
      //   - tagged object (`{ kind: 'Wasm', handle: 5 }`) for enums
      //     whose variants carry payloads. The `kind` field selects
      //     the variant; the same object is passed to the payload
      //     struct encoder.
      const variantName = typeof value === 'string'
        ? value
        : (value as { kind?: string } | null)?.kind;
      if (!variantName) {
        throw new Error(`enum: missing variant tag (got ${JSON.stringify(value)})`);
      }
      const idx = schema.variants.findIndex((v) => v.name === variantName);
      if (idx < 0) throw new Error(`enum: unknown variant ${variantName}`);
      const parts: Uint8Array[] = [u32Varint(idx)];
      const variant = schema.variants[idx];
      if (variant.payload) parts.push(encode(value, variant.payload));
      return concat(parts);
    }
  }
}

export function encodeProjectSnapshot(snap: ProjectSnapshot): Uint8Array {
  return encode(snap, PROJECT_SNAPSHOT);
}
