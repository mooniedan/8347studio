import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { TRACK_PALETTE } from '../track-color';
import {
  createMidiTrack,
  createPianoRollClip,
  createStepSeqClip,
  defaultEmptySteps,
  makeId,
} from './builders';
import {
  clearLegacyHash,
  parseLegacyHash,
  seedDefaults,
  seedDemoSong,
  seedFromLegacy,
} from './demo';

// Y.Doc-backed project state. Schema mirrors `.claude/dream.md` § "Project
// state shape (Yjs)" so later phases extend the same shape rather than
// reshape it.

export const PROJECT_DOC_NAME = '8347-studio-project';

export const STEPS_PER_CLIP = 16;
export const PPQ = 960;
export const STEP_TICKS = PPQ / 4; // 1/16-note grid
export const LOW_MIDI = 48; // Phase-0 step grid baseline (C3)

export type Waveform = 'sine' | 'saw' | 'square';
export const WAVEFORMS: Waveform[] = ['sine', 'saw', 'square'];

export interface Project {
  doc: Y.Doc;
  meta: Y.Map<unknown>;
  tempoMap: Y.Array<TempoSegment>;
  tracks: Y.Array<string>;
  trackById: Y.Map<Y.Map<unknown>>;
  clipById: Y.Map<Y.Map<unknown>>;
  assets: Y.Map<unknown>;
  automation: Y.Map<unknown>;
  destroy(): void;
}

export interface TempoSegment {
  tick: number;
  bpm: number;
  num: number;
  den: number;
}

export interface StepSnapshot {
  tick: number;
  notes: number; // u32 bitmask, bit k = MIDI note (LOW_MIDI + k)
}

interface LegacyHash {
  steps: number[];
  bpm: number | null;
  waveform: Waveform | null;
}

export type SeedMode = 'blank' | 'demo';

export interface CreateProjectOptions {
  /// IndexedDB store name. Defaults to PROJECT_DOC_NAME so the
  /// pre-multi-project setup keeps working unchanged. The multi-
  /// project flow (lib/project-registry.ts) passes a per-project
  /// docName so each project has its own IDB store.
  docName?: string;
  /// One-shot seed selector for a fresh Y.Doc. Ignored if the doc
  /// already has tracks (re-opening an existing project).
  seed?: SeedMode;
  /// When true, skip IndexedDB persistence entirely — the Y.Doc lives
  /// in memory only. Used by the Demo Song slot so edits never hit
  /// disk; the user is prompted to fork into a regular project if
  /// they want to keep their changes.
  ephemeral?: boolean;
}

export async function createProject(opts: CreateProjectOptions = {}): Promise<Project> {
  const docName = opts.docName ?? PROJECT_DOC_NAME;
  const doc = new Y.Doc();
  let destroy: () => void = () => {};
  if (!opts.ephemeral) {
    const provider = new IndexeddbPersistence(docName, doc);
    destroy = () => provider.destroy();
    await provider.whenSynced;
  }
  const project: Project = attach(doc, destroy);

  const legacy = parseLegacyHash();
  if (legacy) {
    seedFromLegacy(project, legacy);
    clearLegacyHash();
  } else if (project.tracks.length === 0) {
    if (opts.seed === 'demo') {
      seedDemoSong(project);
    } else {
      seedDefaults(project);
    }
  } else {
    // Project loaded from IndexedDB. Projects created before the
    // default-loop seed shipped have no loop region; without one
    // the engine runs the timeline once and silences forever, even
    // though the per-clip playhead visually wraps. Fit a loop to
    // the longest clip's end so the user's existing patterns
    // actually loop.
    healMissingLoopRegion(project);
  }

  return project;
}

function healMissingLoopRegion(p: Project): void {
  if (getLoopRegion(p) != null) return;
  // Find the longest clip end across all clips (piano-roll or
  // step-seq). Fall back to a 4-bar loop if the project is empty.
  let maxEnd = 0;
  p.clipById.forEach((clip) => {
    const start = (clip.get('startTick') as number | undefined) ?? 0;
    const length = (clip.get('lengthTicks') as number | undefined) ?? 0;
    const end = start + length;
    if (end > maxEnd) maxEnd = end;
  });
  const barTicks = STEPS_PER_CLIP * STEP_TICKS;
  // Round up to the next whole bar so the loop falls on a musical
  // boundary; minimum 4 bars so freshly-empty existing projects get
  // the same default new ones do.
  const bars = Math.max(DEFAULT_LOOP_BARS, Math.ceil(maxEnd / barTicks));
  setLoopRegion(p, { startTick: 0, endTick: bars * barTicks });
}

/// Build the Project shape on top of an existing Y.Doc. Phase-6 M4
/// uses this to wrap the satellite popup's Y.Doc replica without
/// re-running the IndexedDB-bound createProject flow.
export function projectFromDoc(doc: Y.Doc, destroy: () => void = () => {}): Project {
  return attach(doc, destroy);
}

function attach(doc: Y.Doc, destroy: () => void): Project {
  return {
    doc,
    meta: doc.getMap('meta'),
    tempoMap: doc.getArray<TempoSegment>('tempoMap'),
    tracks: doc.getArray<string>('tracks'),
    trackById: doc.getMap<Y.Map<unknown>>('trackById'),
    clipById: doc.getMap<Y.Map<unknown>>('clipById'),
    assets: doc.getMap<unknown>('assets'),
    automation: doc.getMap<unknown>('automation'),
    destroy() {
      destroy();
      doc.destroy();
    },
  };
}


/// 4-bar default loop = 4 × 16 sixteenth-steps × 240 ticks = 15360.
/// A loop is on by default for fresh projects so a freshly-painted
/// pattern plays continuously — without it, a clip plays once and
/// silence follows forever (transport keeps advancing past the
/// clip's lengthTicks). The Transport UI exposes the toggle + bar
/// inputs so users can disable / extend it.
const DEFAULT_LOOP_BARS = 4;


// ---- Read/write helpers (Phase-1 single-clip view) -----------------------

export function addMidiTrack(p: Project, waveform: Waveform = 'sine'): string {
  let trackId = '';
  p.doc.transact(() => {
    const r = createMidiTrack(p, waveform);
    trackId = r.trackId;
    createStepSeqClip(p, r.trackId, defaultEmptySteps());
  });
  return trackId;
}

/// Add a MIDI track wired to the first-party subtractive synth, with
/// an empty PianoRoll clip (Phase-2 M4) so the user can write notes
/// straight away.
export function addSubtractiveTrack(p: Project): string {
  let trackId = '';
  p.doc.transact(() => {
    const id = makeId('track');
    const track = new Y.Map<unknown>();

    const params = new Y.Map<unknown>();
    const instr = new Y.Map<unknown>();
    instr.set('pluginId', 'builtin:subtractive');
    instr.set('voices', 16);
    instr.set('params', params);

    const idx = p.tracks.length;
    track.set('kind', 'MIDI');
    track.set('name', `Synth ${idx + 1}`);
    track.set('color', TRACK_PALETTE[idx % TRACK_PALETTE.length]);
    track.set('mute', false);
    track.set('solo', false);
    track.set('gain', 1.0);
    track.set('pan', 0);
    track.set('instrumentSlot', instr);
    track.set('inserts', new Y.Array());
    track.set('sends', new Y.Array());
    track.set('clips', new Y.Array<string>());

    p.trackById.set(id, track);
    p.tracks.push([id]);
    createPianoRollClip(p, id);
    trackId = id;
  });
  return trackId;
}

/// Phase-8 M2 — add a drumkit track (5-voice synthesized drums).
/// Uses a PianoRoll clip so the existing ClipScheduler dispatches
/// NoteOn at drum-map pitches (36 kick / 38 snare / 39 clap / 42 chat
/// / 46 ohat) into the instrument. Step-grid editing for drum tracks
/// is a Phase-10 polish item.
export function addDrumkitTrack(p: Project, name?: string): string {
  let trackId = '';
  p.doc.transact(() => {
    const id = makeId('track');
    const track = new Y.Map<unknown>();

    const params = new Y.Map<unknown>();
    const instr = new Y.Map<unknown>();
    instr.set('pluginId', 'builtin:drumkit');
    // Voice count is meaningless for one-shot drum voices, but keep
    // the field present for snapshot compatibility.
    instr.set('voices', 5);
    instr.set('params', params);

    const idx = p.tracks.length;
    track.set('kind', 'MIDI');
    track.set('name', name ?? `Drums ${idx + 1}`);
    track.set('color', TRACK_PALETTE[idx % TRACK_PALETTE.length]);
    track.set('mute', false);
    track.set('solo', false);
    track.set('gain', 1.0);
    track.set('pan', 0);
    track.set('instrumentSlot', instr);
    track.set('inserts', new Y.Array());
    track.set('sends', new Y.Array());
    track.set('clips', new Y.Array<string>());

    p.trackById.set(id, track);
    p.tracks.push([id]);
    createPianoRollClip(p, id);
    trackId = id;
  });
  return trackId;
}

/// Drumkit param ids — mirror crates/audio-engine/src/plugins/drumkit.rs.
/// Append-only.
export const DRUMKIT_PID_KICK_LEVEL = 0;
export const DRUMKIT_PID_KICK_TUNE = 1;
export const DRUMKIT_PID_KICK_DECAY = 2;
export const DRUMKIT_PID_SNARE_LEVEL = 3;
export const DRUMKIT_PID_SNARE_TUNE = 4;
export const DRUMKIT_PID_SNARE_DECAY = 5;
export const DRUMKIT_PID_CLAP_LEVEL = 6;
export const DRUMKIT_PID_CLAP_DECAY = 7;
export const DRUMKIT_PID_CHAT_LEVEL = 8;
export const DRUMKIT_PID_CHAT_DECAY = 9;
export const DRUMKIT_PID_OHAT_LEVEL = 10;
export const DRUMKIT_PID_OHAT_DECAY = 11;
export const DRUMKIT_PID_GAIN = 12;

/// Drum-map pitches — match crates/audio-engine/src/plugins/drumkit.rs.
export const DRUM_PITCH_KICK = 36;
export const DRUM_PITCH_SNARE = 38;
export const DRUM_PITCH_CLAP = 39;
export const DRUM_PITCH_CHAT = 42;
export const DRUM_PITCH_OHAT = 46;


export interface PianoRollNote {
  pitch: number;
  velocity: number;
  startTick: number;
  lengthTicks: number;
}

export function getPianoRollClipForTrack(p: Project, idx: number): Y.Map<unknown> | null {
  if (idx < 0 || idx >= p.tracks.length) return null;
  const id = p.tracks.get(idx);
  const track = p.trackById.get(id);
  if (!track) return null;
  const clipIds = track.get('clips') as Y.Array<string> | undefined;
  if (!clipIds) return null;
  for (const cid of clipIds.toArray()) {
    const clip = p.clipById.get(cid);
    if (clip?.get('kind') === 'PianoRoll') return clip;
  }
  return null;
}

export function readPianoRollNotes(clip: Y.Map<unknown>): PianoRollNote[] {
  const arr = clip.get('notes') as Y.Array<Y.Map<unknown>> | undefined;
  if (!arr) return [];
  return arr.toArray().map((n) => ({
    pitch: ((n.get('pitch') as number | undefined) ?? 60) & 0xff,
    velocity: ((n.get('velocity') as number | undefined) ?? 100) & 0xff,
    startTick: (n.get('startTick') as number | undefined) ?? 0,
    lengthTicks: (n.get('lengthTicks') as number | undefined) ?? 0,
  }));
}

export function addPianoRollNote(
  p: Project,
  clip: Y.Map<unknown>,
  note: PianoRollNote,
): void {
  const arr = clip.get('notes') as Y.Array<Y.Map<unknown>>;
  p.doc.transact(() => {
    const n = new Y.Map<unknown>();
    n.set('pitch', note.pitch);
    n.set('velocity', note.velocity);
    n.set('startTick', note.startTick);
    n.set('lengthTicks', note.lengthTicks);
    arr.push([n]);
  });
}

/// Per-note velocity writer. Mutates the velocity field in place so
/// the note keeps its array index — this matters for the M2c
/// velocity lane (live drag) where stable bar positions across
/// updates avoid flicker.
export function setPianoRollNoteVelocity(
  p: Project,
  clip: Y.Map<unknown>,
  pitch: number,
  startTick: number,
  velocity: number,
): boolean {
  const arr = clip.get('notes') as Y.Array<Y.Map<unknown>>;
  let found: Y.Map<unknown> | null = null;
  arr.forEach((n) => {
    if (
      found == null &&
      ((n.get('pitch') as number) & 0xff) === pitch &&
      (n.get('startTick') as number) === startTick
    ) {
      found = n;
    }
  });
  if (!found) return false;
  const clamped = Math.max(0, Math.min(127, Math.round(velocity))) & 0xff;
  p.doc.transact(() => found!.set('velocity', clamped));
  return true;
}

export function removePianoRollNoteAt(
  p: Project,
  clip: Y.Map<unknown>,
  pitch: number,
  startTick: number,
): boolean {
  const arr = clip.get('notes') as Y.Array<Y.Map<unknown>>;
  let found = -1;
  arr.forEach((n, i) => {
    if (
      ((n.get('pitch') as number) & 0xff) === pitch &&
      (n.get('startTick') as number) === startTick &&
      found < 0
    ) {
      found = i;
    }
  });
  if (found < 0) return false;
  p.doc.transact(() => arr.delete(found, 1));
  return true;
}

/// Per-param Y.Doc → engine writer. Param ids are stringified to match
/// Y.Map's string-keyed contract; the engine consumes them as u32.
export function setSynthParam(p: Project, trackIdx: number, paramId: number, value: number): void {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return;
  const id = p.tracks.get(trackIdx);
  const track = p.trackById.get(id);
  if (!track || track.get('kind') !== 'MIDI') return;
  const instr = track.get('instrumentSlot') as Y.Map<unknown> | undefined;
  if (!instr || instr.get('pluginId') !== 'builtin:subtractive') return;
  let params = instr.get('params') as Y.Map<unknown> | undefined;
  if (!params) {
    params = new Y.Map<unknown>();
    instr.set('params', params);
  }
  params.set(String(paramId), value);
}

export function getSynthParam(p: Project, trackIdx: number, paramId: number): number | null {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return null;
  const id = p.tracks.get(trackIdx);
  const track = p.trackById.get(id);
  if (!track || track.get('kind') !== 'MIDI') return null;
  const instr = track.get('instrumentSlot') as Y.Map<unknown> | undefined;
  if (!instr) return null;
  const params = instr.get('params') as Y.Map<unknown> | undefined;
  if (!params) return null;
  const v = params.get(String(paramId));
  return typeof v === 'number' ? v : null;
}

/// Y.Doc-backed arming state. `meta.armedTrackId` holds the trackId
/// (string id, not index) of the single armed track — null when none.
/// Single-track for Phase 3; multi-arm is Phase 9.
export function getArmedTrackId(p: Project): string | null {
  const v = p.meta.get('armedTrackId');
  return typeof v === 'string' ? v : null;
}

export function setArmedTrackId(p: Project, trackId: string | null): void {
  if (trackId == null) {
    p.meta.delete('armedTrackId');
  } else {
    p.meta.set('armedTrackId', trackId);
  }
}

/// Resolve the armed track id to a current index, or -1 if no track
/// is armed (or the armed track has been removed).
export function getArmedTrackIdx(p: Project): number {
  const id = getArmedTrackId(p);
  if (!id) return -1;
  return p.tracks.toArray().indexOf(id);
}

/// Automation lanes — Phase-4 M4. Stored under `automation` Y.Map
/// keyed by `${trackId}:${kind}:${slotIdx}:${paramId}`. Value is a
/// Y.Map { points: Y.Array<Y.Map<{ tick, value }>> }.
export type AutoTargetKind = 'instrument' | 'insert';

export interface AutomationPoint {
  tick: number;
  value: number;
}

export interface AutomationLaneView {
  trackId: string;
  trackIdx: number;
  target: AutoTargetKind;
  slotIdx: number;
  paramId: number;
  points: AutomationPoint[];
}

function automationRoot(p: Project): Y.Map<Y.Map<unknown>> {
  let m = p.automation as Y.Map<unknown> as unknown as Y.Map<Y.Map<unknown>>;
  // p.automation is created in createProject — guaranteed.
  return m;
}

function laneKey(trackId: string, target: AutoTargetKind, slotIdx: number, paramId: number): string {
  return `${trackId}:${target}:${slotIdx}:${paramId}`;
}

function findLane(
  p: Project,
  trackIdx: number,
  target: AutoTargetKind,
  slotIdx: number,
  paramId: number,
): { key: string; lane: Y.Map<unknown>; trackId: string } | null {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return null;
  const trackId = p.tracks.get(trackIdx);
  const key = laneKey(trackId, target, slotIdx, paramId);
  const lane = automationRoot(p).get(key);
  return lane ? { key, lane: lane as Y.Map<unknown>, trackId } : null;
}

export function addAutomationPoint(
  p: Project,
  trackIdx: number,
  target: AutoTargetKind,
  slotIdx: number,
  paramId: number,
  point: AutomationPoint,
): void {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return;
  const trackId = p.tracks.get(trackIdx);
  const root = automationRoot(p);
  const key = laneKey(trackId, target, slotIdx, paramId);
  p.doc.transact(() => {
    let lane = root.get(key) as Y.Map<unknown> | undefined;
    if (!lane) {
      lane = new Y.Map<unknown>();
      lane.set('points', new Y.Array<Y.Map<unknown>>());
      root.set(key, lane);
    }
    const points = lane.get('points') as Y.Array<Y.Map<unknown>>;
    // Insertion-sorted by tick to keep the engine's evaluation cheap.
    let insertAt = points.length;
    for (let i = 0; i < points.length; i++) {
      const t = (points.get(i).get('tick') as number | undefined) ?? 0;
      if (t > point.tick) {
        insertAt = i;
        break;
      }
    }
    const ymap = new Y.Map<unknown>();
    ymap.set('tick', Math.max(0, Math.floor(point.tick)));
    ymap.set('value', point.value);
    points.insert(insertAt, [ymap]);
  });
}

export function removeAutomationPoint(
  p: Project,
  trackIdx: number,
  target: AutoTargetKind,
  slotIdx: number,
  paramId: number,
  pointIdx: number,
): void {
  const found = findLane(p, trackIdx, target, slotIdx, paramId);
  if (!found) return;
  const points = found.lane.get('points') as Y.Array<Y.Map<unknown>>;
  if (pointIdx < 0 || pointIdx >= points.length) return;
  p.doc.transact(() => {
    points.delete(pointIdx, 1);
    if (points.length === 0) {
      automationRoot(p).delete(found.key);
    }
  });
}

export function getAutomationLane(
  p: Project,
  trackIdx: number,
  target: AutoTargetKind,
  slotIdx: number,
  paramId: number,
): AutomationPoint[] {
  const found = findLane(p, trackIdx, target, slotIdx, paramId);
  if (!found) return [];
  const points = found.lane.get('points') as Y.Array<Y.Map<unknown>> | undefined;
  if (!points) return [];
  const out: AutomationPoint[] = [];
  points.forEach((pm) => {
    const tick = (pm.get('tick') as number | undefined) ?? 0;
    const value = (pm.get('value') as number | undefined) ?? 0;
    out.push({ tick, value });
  });
  return out;
}

export function listAutomationLanes(p: Project): AutomationLaneView[] {
  const out: AutomationLaneView[] = [];
  const trackIds = p.tracks.toArray();
  automationRoot(p).forEach((lane, key) => {
    const parts = key.split(':');
    if (parts.length !== 4) return;
    const trackId = parts[0];
    const target = parts[1] as AutoTargetKind;
    const slotIdx = parseInt(parts[2], 10);
    const paramId = parseInt(parts[3], 10);
    if (Number.isNaN(slotIdx) || Number.isNaN(paramId)) return;
    const trackIdx = trackIds.indexOf(trackId);
    const points = (lane.get('points') as Y.Array<Y.Map<unknown>> | undefined) ?? null;
    const pts: AutomationPoint[] = [];
    points?.forEach((pm) => {
      const t = (pm.get('tick') as number | undefined) ?? 0;
      const v = (pm.get('value') as number | undefined) ?? 0;
      pts.push({ tick: t, value: v });
    });
    out.push({ trackId, trackIdx, target, slotIdx, paramId, points: pts });
  });
  return out;
}

/// MIDI Learn — Phase-3 M4. Store CC# → { trackIdx, paramId }
/// bindings under `meta.midiBindings`. Phase 9 will key by deviceId
/// too; for now Phase-3 assumes one hardware controller at a time.
export interface MidiBinding {
  trackIdx: number;
  paramId: number;
}

function getOrCreateMidiBindings(p: Project): Y.Map<Y.Map<unknown>> {
  let m = p.meta.get('midiBindings') as Y.Map<Y.Map<unknown>> | undefined;
  if (!m) {
    m = new Y.Map<Y.Map<unknown>>();
    p.meta.set('midiBindings', m);
  }
  return m;
}

export function getMidiBinding(p: Project, cc: number): MidiBinding | null {
  const m = p.meta.get('midiBindings') as Y.Map<Y.Map<unknown>> | undefined;
  if (!m) return null;
  const entry = m.get(String(cc));
  if (!entry) return null;
  const trackIdx = entry.get('trackIdx') as number | undefined;
  const paramId = entry.get('paramId') as number | undefined;
  if (typeof trackIdx !== 'number' || typeof paramId !== 'number') return null;
  return { trackIdx, paramId };
}

export function setMidiBinding(p: Project, cc: number, binding: MidiBinding): void {
  const m = getOrCreateMidiBindings(p);
  p.doc.transact(() => {
    const entry = new Y.Map<unknown>();
    entry.set('trackIdx', binding.trackIdx);
    entry.set('paramId', binding.paramId);
    m.set(String(cc), entry);
  });
}

export function removeMidiBinding(p: Project, cc: number): void {
  const m = p.meta.get('midiBindings') as Y.Map<Y.Map<unknown>> | undefined;
  if (!m) return;
  p.doc.transact(() => m.delete(String(cc)));
}

export function listMidiBindings(p: Project): { cc: number; binding: MidiBinding }[] {
  const m = p.meta.get('midiBindings') as Y.Map<Y.Map<unknown>> | undefined;
  if (!m) return [];
  const out: { cc: number; binding: MidiBinding }[] = [];
  m.forEach((entry, key) => {
    const cc = parseInt(key, 10);
    if (Number.isNaN(cc)) return;
    const trackIdx = entry.get('trackIdx') as number | undefined;
    const paramId = entry.get('paramId') as number | undefined;
    if (typeof trackIdx === 'number' && typeof paramId === 'number') {
      out.push({ cc, binding: { trackIdx, paramId } });
    }
  });
  return out;
}

/// Add an Audio track. Phase-5 M3. Audio tracks have no instrument
/// and host AudioRegion clips referencing OPFS-stored assets by hash.
export function addAudioTrack(p: Project, name?: string): string {
  let trackId = '';
  p.doc.transact(() => {
    const id = makeId('track');
    const track = new Y.Map<unknown>();
    const idx = p.tracks.length;
    track.set('kind', 'Audio');
    track.set('name', name ?? `Audio ${idx + 1}`);
    track.set('color', TRACK_PALETTE[idx % TRACK_PALETTE.length]);
    track.set('mute', false);
    track.set('solo', false);
    track.set('gain', 1.0);
    track.set('pan', 0);
    track.set('clips', new Y.Array<string>());
    track.set('inserts', new Y.Array());
    track.set('sends', new Y.Array());
    track.set('audioRegions', new Y.Array<Y.Map<unknown>>());
    p.trackById.set(id, track);
    p.tracks.push([id]);
    trackId = id;
  });
  return trackId;
}

export interface AudioRegionView {
  assetHash: string;
  startTick: number;
  lengthTicks: number;
  startSample: number;
  lengthSamples: number;
  assetOffsetSamples: number;
  gain: number;
  fadeInSamples: number;
  fadeOutSamples: number;
}

export interface AudioRegionInput {
  assetHash: string;
  startTick: number;
  lengthTicks: number;
  startSample: number;
  lengthSamples: number;
  assetOffsetSamples?: number;
  gain?: number;
  fadeInSamples?: number;
  fadeOutSamples?: number;
}

function trackAudioRegionsArr(p: Project, trackIdx: number): Y.Array<Y.Map<unknown>> | null {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return null;
  const id = p.tracks.get(trackIdx);
  const track = p.trackById.get(id);
  if (!track || track.get('kind') !== 'Audio') return null;
  return (track.get('audioRegions') as Y.Array<Y.Map<unknown>> | undefined) ?? null;
}

export function addAudioRegion(
  p: Project,
  trackIdx: number,
  region: AudioRegionInput,
): void {
  const arr = trackAudioRegionsArr(p, trackIdx);
  if (!arr) return;
  p.doc.transact(() => {
    const r = new Y.Map<unknown>();
    r.set('assetHash', region.assetHash);
    r.set('startTick', Math.max(0, Math.floor(region.startTick)));
    r.set('lengthTicks', Math.max(0, Math.floor(region.lengthTicks)));
    r.set('startSample', Math.max(0, Math.floor(region.startSample)));
    r.set('lengthSamples', Math.max(0, Math.floor(region.lengthSamples)));
    r.set('assetOffsetSamples', Math.max(0, Math.floor(region.assetOffsetSamples ?? 0)));
    r.set('gain', region.gain ?? 1.0);
    r.set('fadeInSamples', Math.max(0, Math.floor(region.fadeInSamples ?? 0)));
    r.set('fadeOutSamples', Math.max(0, Math.floor(region.fadeOutSamples ?? 0)));
    arr.push([r]);
  });
}

/// Phase-10 M3c — audio-region geometry writer used by the drag-
/// to-move + trim-handle UX. Patches are applied in a single
/// transaction so peers see one consistent update per drag instead
/// of a flurry. Negative / sub-minimum values are clamped here so
/// the engine never sees a degenerate region.
export interface AudioRegionPatch {
  startTick?: number;
  lengthTicks?: number;
  startSample?: number;
  lengthSamples?: number;
  assetOffsetSamples?: number;
}

export function updateAudioRegion(
  p: Project,
  trackIdx: number,
  regionIdx: number,
  patch: AudioRegionPatch,
): boolean {
  const arr = trackAudioRegionsArr(p, trackIdx);
  if (!arr || regionIdx < 0 || regionIdx >= arr.length) return false;
  const r = arr.get(regionIdx);
  if (!r) return false;
  p.doc.transact(() => {
    if (patch.startTick !== undefined) {
      r.set('startTick', Math.max(0, Math.floor(patch.startTick)));
    }
    if (patch.lengthTicks !== undefined) {
      r.set('lengthTicks', Math.max(1, Math.floor(patch.lengthTicks)));
    }
    if (patch.startSample !== undefined) {
      r.set('startSample', Math.max(0, Math.floor(patch.startSample)));
    }
    if (patch.lengthSamples !== undefined) {
      r.set('lengthSamples', Math.max(1, Math.floor(patch.lengthSamples)));
    }
    if (patch.assetOffsetSamples !== undefined) {
      r.set('assetOffsetSamples', Math.max(0, Math.floor(patch.assetOffsetSamples)));
    }
  });
  return true;
}

/// Per-region fade writer. `which` selects in/out; the sample value
/// is clamped non-negative and capped at the region's length so a
/// fade can never overlap the opposite end. Used by the inspector
/// edit panel (Phase-10 M3d) and exposed via the debug bridge so
/// tests + demo-song seeders can set fades without spinning up the
/// UI.
/// Per-region gain writer. Clamps to [0, 4] — the engine accepts
/// > 1 (boost) and we don't want UI sliders to allow extreme values
/// that surprise the user with silence-then-clipping.
export function setAudioRegionGain(
  p: Project,
  trackIdx: number,
  regionIdx: number,
  gain: number,
): boolean {
  const arr = trackAudioRegionsArr(p, trackIdx);
  if (!arr || regionIdx < 0 || regionIdx >= arr.length) return false;
  const r = arr.get(regionIdx);
  if (!r) return false;
  const clamped = Math.max(0, Math.min(4, Number(gain) || 0));
  p.doc.transact(() => r.set('gain', clamped));
  return true;
}

export function setAudioRegionFade(
  p: Project,
  trackIdx: number,
  regionIdx: number,
  which: 'in' | 'out',
  samples: number,
): boolean {
  const arr = trackAudioRegionsArr(p, trackIdx);
  if (!arr || regionIdx < 0 || regionIdx >= arr.length) return false;
  const r = arr.get(regionIdx);
  if (!r) return false;
  const lengthSamples = (r.get('lengthSamples') as number | undefined) ?? 0;
  const clamped = Math.max(0, Math.min(lengthSamples, Math.floor(samples)));
  const field = which === 'in' ? 'fadeInSamples' : 'fadeOutSamples';
  p.doc.transact(() => r.set(field, clamped));
  return true;
}

export function getAudioRegions(p: Project, trackIdx: number): AudioRegionView[] {
  const arr = trackAudioRegionsArr(p, trackIdx);
  if (!arr) return [];
  const out: AudioRegionView[] = [];
  arr.forEach((r) => {
    const assetHash = (r.get('assetHash') as string | undefined) ?? '';
    if (!assetHash) return;
    out.push({
      assetHash,
      startTick: (r.get('startTick') as number | undefined) ?? 0,
      lengthTicks: (r.get('lengthTicks') as number | undefined) ?? 0,
      startSample: (r.get('startSample') as number | undefined) ?? 0,
      lengthSamples: (r.get('lengthSamples') as number | undefined) ?? 0,
      assetOffsetSamples: (r.get('assetOffsetSamples') as number | undefined) ?? 0,
      gain: (r.get('gain') as number | undefined) ?? 1.0,
      fadeInSamples: (r.get('fadeInSamples') as number | undefined) ?? 0,
      fadeOutSamples: (r.get('fadeOutSamples') as number | undefined) ?? 0,
    });
  });
  return out;
}

export interface AssetMetadataView {
  channels: number;
  sampleRate: number;
  frames: number;
  sourceFilename?: string;
  format?: string;
}

export function setAssetMetadata(p: Project, hash: string, meta: AssetMetadataView): void {
  p.doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('channels', meta.channels);
    m.set('sampleRate', meta.sampleRate);
    m.set('frames', meta.frames);
    if (meta.sourceFilename != null) m.set('sourceFilename', meta.sourceFilename);
    if (meta.format != null) m.set('format', meta.format);
    p.assets.set(hash, m);
  });
}

export function getAssetMetadata(p: Project, hash: string): AssetMetadataView | null {
  const m = p.assets.get(hash) as Y.Map<unknown> | undefined;
  if (!m) return null;
  const channels = m.get('channels') as number | undefined;
  const sampleRate = m.get('sampleRate') as number | undefined;
  const frames = m.get('frames') as number | undefined;
  if (typeof channels !== 'number' || typeof sampleRate !== 'number' || typeof frames !== 'number') {
    return null;
  }
  return {
    channels,
    sampleRate,
    frames,
    sourceFilename: m.get('sourceFilename') as string | undefined,
    format: m.get('format') as string | undefined,
  };
}

/// Add a Bus track. Buses host inserts (e.g. a reverb plugin in M3+)
/// and aggregate signal from any track that sends to them. Phase-4 M2.
export function addBusTrack(p: Project, name?: string): string {
  let trackId = '';
  p.doc.transact(() => {
    const id = makeId('track');
    const track = new Y.Map<unknown>();
    const idx = p.tracks.length;
    track.set('kind', 'Bus');
    track.set('name', name ?? `Bus ${idx + 1}`);
    track.set('color', TRACK_PALETTE[idx % TRACK_PALETTE.length]);
    track.set('mute', false);
    track.set('solo', false);
    track.set('gain', 1.0);
    track.set('pan', 0);
    // No instrumentSlot. Empty clips/inserts/sends Y.Arrays so callers
    // that assume "always present" stay safe.
    track.set('clips', new Y.Array<string>());
    track.set('inserts', new Y.Array());
    track.set('sends', new Y.Array());
    p.trackById.set(id, track);
    p.tracks.push([id]);
    trackId = id;
  });
  return trackId;
}

export interface SendView {
  targetTrackId: string;
  targetTrackIdx: number;
  level: number;
  preFader: boolean;
}

function trackSendArr(p: Project, trackIdx: number): Y.Array<Y.Map<unknown>> | null {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return null;
  const id = p.tracks.get(trackIdx);
  const track = p.trackById.get(id);
  if (!track) return null;
  return (track.get('sends') as Y.Array<Y.Map<unknown>> | undefined) ?? null;
}

export function getTrackSends(p: Project, trackIdx: number): SendView[] {
  const arr = trackSendArr(p, trackIdx);
  if (!arr) return [];
  const trackIds = p.tracks.toArray();
  const out: SendView[] = [];
  arr.forEach((s) => {
    const tid = s.get('targetTrackId') as string | undefined;
    if (!tid) return;
    const idx = trackIds.indexOf(tid);
    out.push({
      targetTrackId: tid,
      targetTrackIdx: idx,
      level: (s.get('level') as number | undefined) ?? 1.0,
      preFader: Boolean(s.get('preFader')),
    });
  });
  return out;
}

export function addSend(
  p: Project,
  fromTrackIdx: number,
  toTrackId: string,
  level = 0.5,
): void {
  const arr = trackSendArr(p, fromTrackIdx);
  if (!arr) return;
  // Reject self-routing.
  const fromId = p.tracks.get(fromTrackIdx);
  if (fromId === toTrackId) return;
  // Reject if target isn't a Bus.
  const target = p.trackById.get(toTrackId);
  if (!target || target.get('kind') !== 'Bus') return;
  p.doc.transact(() => {
    const send = new Y.Map<unknown>();
    send.set('targetTrackId', toTrackId);
    send.set('level', level);
    send.set('preFader', false);
    arr.push([send]);
  });
}

export function removeSend(p: Project, trackIdx: number, sendIdx: number): void {
  const arr = trackSendArr(p, trackIdx);
  if (!arr || sendIdx < 0 || sendIdx >= arr.length) return;
  p.doc.transact(() => arr.delete(sendIdx, 1));
}

export function setSendLevel(
  p: Project,
  trackIdx: number,
  sendIdx: number,
  level: number,
): void {
  const arr = trackSendArr(p, trackIdx);
  if (!arr || sendIdx < 0 || sendIdx >= arr.length) return;
  arr.get(sendIdx)?.set('level', level);
}

/// List the tracks that can be a send target (i.e. all Bus tracks
/// that aren't the sender itself).
export function listBusTargets(p: Project, fromTrackIdx: number): { id: string; name: string; idx: number }[] {
  const fromId = fromTrackIdx >= 0 && fromTrackIdx < p.tracks.length ? p.tracks.get(fromTrackIdx) : null;
  const out: { id: string; name: string; idx: number }[] = [];
  for (let i = 0; i < p.tracks.length; i++) {
    const tid = p.tracks.get(i);
    if (tid === fromId) continue;
    const t = p.trackById.get(tid);
    if (t?.get('kind') !== 'Bus') continue;
    out.push({
      id: tid,
      name: (t.get('name') as string | undefined) ?? `Bus ${i + 1}`,
      idx: i,
    });
  }
  return out;
}

/// Insert FX chain helpers — Phase-4 M1 (Gain) extended in M3 with
/// EQ, Compressor, Reverb, Delay. Each insert is a Y.Map with
/// pluginId, params (Y.Map<paramId-string, number>), and bypass.
export type InsertPluginId =
  | 'builtin:gain'
  | 'builtin:eq'
  | 'builtin:compressor'
  | 'builtin:reverb'
  | 'builtin:delay'
  | 'builtin:container'
  | 'wasm';

export interface InsertView {
  kind: InsertPluginId;
  params: Record<number, number>;
  bypass: boolean;
}

const INSERT_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'builtin:gain',
  'builtin:eq',
  'builtin:compressor',
  'builtin:reverb',
  'builtin:delay',
  'builtin:container',
  'wasm',
]);

function trackInsertArr(p: Project, trackIdx: number): Y.Array<Y.Map<unknown>> | null {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return null;
  const id = p.tracks.get(trackIdx);
  const track = p.trackById.get(id);
  if (!track) return null;
  return (track.get('inserts') as Y.Array<Y.Map<unknown>> | undefined) ?? null;
}

export function getTrackInserts(p: Project, trackIdx: number): InsertView[] {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr) return [];
  const out: InsertView[] = [];
  arr.forEach((slot) => {
    const pid = slot.get('pluginId') as string;
    if (!INSERT_PLUGIN_IDS.has(pid)) return;
    const params: Record<number, number> = {};
    const ymap = slot.get('params') as Y.Map<unknown> | undefined;
    ymap?.forEach((v, k) => {
      const id = parseInt(k, 10);
      if (!Number.isNaN(id) && typeof v === 'number') params[id] = v;
    });
    out.push({ kind: pid as InsertPluginId, params, bypass: Boolean(slot.get('bypass')) });
  });
  return out;
}

export function addInsert(p: Project, trackIdx: number, kind: InsertPluginId): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr) return;
  p.doc.transact(() => {
    const slot = new Y.Map<unknown>();
    slot.set('pluginId', kind);
    slot.set('bypass', false);
    slot.set('params', new Y.Map<unknown>());
    if (kind === 'builtin:container') {
      // Default: 2 empty branches so parallel routing exists out of
      // the box; user can add inserts inside each via the bridge
      // helpers below (UI for branch editing is a Phase-9 polish
      // item).
      const branches = new Y.Array<Y.Map<unknown>>();
      for (let i = 0; i < 2; i++) {
        const b = new Y.Map<unknown>();
        b.set('gain', 1.0);
        b.set('inserts', new Y.Array<Y.Map<unknown>>());
        branches.push([b]);
      }
      slot.set('branches', branches);
    }
    arr.push([slot]);
  });
}

/// Phase-8 M6 — add a third-party WASM plugin as a track insert.
/// `handle` is assigned by the worklet at plugin-load time (via
/// `audio.postLoadWasmPlugin`); callers must register the plugin
/// first, then pass the returned handle here. Stored alongside
/// `pluginId='wasm'` so the engine-bridge encoder emits the
/// `InsertKind::Wasm { handle }` snapshot variant.
///
/// This direct-handle path is the runtime-only variant — handles
/// don't survive reload. The picker path (`addWasmInsertByManifest`)
/// also writes a stable `manifestId` so reloads can rebind to a
/// fresh handle.
export function addWasmInsert(p: Project, trackIdx: number, handle: number): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr) return;
  p.doc.transact(() => {
    const slot = new Y.Map<unknown>();
    slot.set('pluginId', 'wasm');
    slot.set('wasmHandle', handle);
    slot.set('bypass', false);
    slot.set('params', new Y.Map<unknown>());
    arr.push([slot]);
  });
}

/// Phase-8 M5b — picker entry point. Stores the slot with a stable
/// manifest id, so on reload the engine-bridge can look up the
/// freshly-registered handle for the same plugin. The handle itself
/// is the runtime-only resolution; manifestId is what survives.
export function addWasmInsertByManifest(
  p: Project,
  trackIdx: number,
  manifestId: string,
): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr) return;
  p.doc.transact(() => {
    const slot = new Y.Map<unknown>();
    slot.set('pluginId', 'wasm');
    slot.set('manifestId', manifestId);
    slot.set('bypass', false);
    slot.set('params', new Y.Map<unknown>());
    arr.push([slot]);
  });
}

// ---- Phase-8 M5b — installed plugin registry (persisted) ------------
//
// `meta.installedPlugins` is a Y.Map<manifestId, JSON-encoded
// PluginManifest>. JSON stringification keeps the value a flat
// blob the picker round-trips; we don't need Y.Doc-level partial
// edits on individual manifest fields.

function installedPluginsMap(p: Project): Y.Map<unknown> {
  let m = p.meta.get('installedPlugins') as Y.Map<unknown> | undefined;
  if (!m) {
    m = new Y.Map<unknown>();
    p.meta.set('installedPlugins', m);
  }
  return m;
}

export function recordInstalledPlugin(
  p: Project,
  manifestId: string,
  manifestJson: string,
): void {
  p.doc.transact(() => {
    installedPluginsMap(p).set(manifestId, manifestJson);
  });
}

export function listInstalledPlugins(p: Project): { id: string; manifestJson: string }[] {
  const m = p.meta.get('installedPlugins') as Y.Map<unknown> | undefined;
  if (!m) return [];
  const out: { id: string; manifestJson: string }[] = [];
  m.forEach((v, k) => {
    if (typeof v === 'string') out.push({ id: k, manifestJson: v });
  });
  return out;
}

export function forgetInstalledPlugin(p: Project, manifestId: string): void {
  p.doc.transact(() => {
    installedPluginsMap(p).delete(manifestId);
  });
}

/// Add a sub-insert inside a Container slot's branch. Phase-4 M5.
/// Errors silently when the addressed slot isn't a Container or the
/// branch index is out of range.
export function addContainerSubInsert(
  p: Project,
  trackIdx: number,
  slotIdx: number,
  branchIdx: number,
  kind: InsertPluginId,
): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr || slotIdx < 0 || slotIdx >= arr.length) return;
  const slot = arr.get(slotIdx);
  if (slot.get('pluginId') !== 'builtin:container') return;
  const branches = slot.get('branches') as Y.Array<Y.Map<unknown>> | undefined;
  if (!branches || branchIdx < 0 || branchIdx >= branches.length) return;
  const branch = branches.get(branchIdx);
  const inner = branch.get('inserts') as Y.Array<Y.Map<unknown>> | undefined;
  if (!inner) return;
  p.doc.transact(() => {
    const sub = new Y.Map<unknown>();
    sub.set('pluginId', kind);
    sub.set('bypass', false);
    sub.set('params', new Y.Map<unknown>());
    inner.push([sub]);
  });
}

export function setContainerBranchGain(
  p: Project,
  trackIdx: number,
  slotIdx: number,
  branchIdx: number,
  gain: number,
): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr || slotIdx < 0 || slotIdx >= arr.length) return;
  const slot = arr.get(slotIdx);
  if (slot.get('pluginId') !== 'builtin:container') return;
  const branches = slot.get('branches') as Y.Array<Y.Map<unknown>> | undefined;
  if (!branches || branchIdx < 0 || branchIdx >= branches.length) return;
  branches.get(branchIdx)?.set('gain', gain);
}

export function setContainerSubInsertParam(
  p: Project,
  trackIdx: number,
  slotIdx: number,
  branchIdx: number,
  subIdx: number,
  paramId: number,
  value: number,
): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr || slotIdx < 0 || slotIdx >= arr.length) return;
  const slot = arr.get(slotIdx);
  if (slot.get('pluginId') !== 'builtin:container') return;
  const branches = slot.get('branches') as Y.Array<Y.Map<unknown>> | undefined;
  if (!branches || branchIdx < 0 || branchIdx >= branches.length) return;
  const inner = branches.get(branchIdx).get('inserts') as Y.Array<Y.Map<unknown>> | undefined;
  if (!inner || subIdx < 0 || subIdx >= inner.length) return;
  let params = inner.get(subIdx).get('params') as Y.Map<unknown> | undefined;
  if (!params) {
    params = new Y.Map<unknown>();
    inner.get(subIdx).set('params', params);
  }
  params.set(String(paramId), value);
}

export function removeInsert(p: Project, trackIdx: number, slotIdx: number): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr || slotIdx < 0 || slotIdx >= arr.length) return;
  p.doc.transact(() => arr.delete(slotIdx, 1));
}

export function setInsertBypass(
  p: Project,
  trackIdx: number,
  slotIdx: number,
  bypass: boolean,
): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr || slotIdx < 0 || slotIdx >= arr.length) return;
  arr.get(slotIdx)?.set('bypass', bypass);
}

export function setInsertParam(
  p: Project,
  trackIdx: number,
  slotIdx: number,
  paramId: number,
  value: number,
): void {
  const arr = trackInsertArr(p, trackIdx);
  if (!arr || slotIdx < 0 || slotIdx >= arr.length) return;
  const slot = arr.get(slotIdx);
  let params = slot?.get('params') as Y.Map<unknown> | undefined;
  if (!params) {
    params = new Y.Map<unknown>();
    slot?.set('params', params);
  }
  params.set(String(paramId), value);
}

export function getTrackPluginId(p: Project, trackIdx: number): string | null {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return null;
  const id = p.tracks.get(trackIdx);
  const track = p.trackById.get(id);
  const instr = track?.get('instrumentSlot') as Y.Map<unknown> | undefined;
  return (instr?.get('pluginId') as string | undefined) ?? null;
}

export function removeTrack(p: Project, idx: number): void {
  if (idx < 0 || idx >= p.tracks.length) return;
  p.doc.transact(() => {
    const id = p.tracks.get(idx);
    const track = p.trackById.get(id);
    const clipIds = (track?.get('clips') as Y.Array<string> | undefined)?.toArray() ?? [];
    p.tracks.delete(idx, 1);
    p.trackById.delete(id);
    for (const cid of clipIds) {
      p.clipById.delete(cid);
    }
  });
}

export function getStepSeqClipForTrack(p: Project, idx: number): Y.Map<unknown> | null {
  if (idx < 0 || idx >= p.tracks.length) return null;
  const id = p.tracks.get(idx);
  const track = p.trackById.get(id);
  if (!track || track.get('kind') !== 'MIDI') return null;
  const clipIds = track.get('clips') as Y.Array<string> | undefined;
  if (!clipIds || clipIds.length === 0) return null;
  const clip = p.clipById.get(clipIds.get(0));
  if (!clip || clip.get('kind') !== 'StepSeq') return null;
  return clip;
}

export function getTrackName(p: Project, idx: number): string {
  if (idx < 0 || idx >= p.tracks.length) return '';
  const id = p.tracks.get(idx);
  const track = p.trackById.get(id);
  return ((track?.get('name') as string | undefined) ?? '');
}

export function getTrackColor(p: Project, idx: number): string {
  if (idx < 0 || idx >= p.tracks.length) return '#888';
  const id = p.tracks.get(idx);
  const track = p.trackById.get(id);
  return ((track?.get('color') as string | undefined) ?? '#888');
}

export function getFirstStepSeqClip(p: Project): Y.Map<unknown> | null {
  for (const id of p.tracks.toArray()) {
    const track = p.trackById.get(id);
    if (!track) continue;
    if (track.get('kind') !== 'MIDI') continue;
    const clipIds = track.get('clips') as Y.Array<string> | undefined;
    if (!clipIds || clipIds.length === 0) continue;
    const clip = p.clipById.get(clipIds.get(0));
    if (!clip) continue;
    if (clip.get('kind') === 'StepSeq') return clip;
  }
  return null;
}

export function readSteps(clip: Y.Map<unknown>): number[] {
  const arr = clip.get('steps') as Y.Array<Y.Map<unknown>> | undefined;
  if (!arr) return defaultEmptySteps();
  return arr.toArray().map((s) => (s.get('notes') as number) >>> 0);
}

export function writeStepNotes(clip: Y.Map<unknown>, index: number, notes: number): void {
  const arr = clip.get('steps') as Y.Array<Y.Map<unknown>>;
  const step = arr.get(index);
  step.set('notes', notes >>> 0);
}

/// Phase-10 M1 — read per-step velocities. Older clips that pre-date
/// the velocity field fall back to 100 so the engine plays them at
/// the legacy fixed-gain trigger level.
export function readStepVelocities(clip: Y.Map<unknown>): number[] {
  const arr = clip.get('steps') as Y.Array<Y.Map<unknown>> | undefined;
  if (!arr) return Array<number>(STEPS_PER_CLIP).fill(100);
  return arr.toArray().map((s) => {
    const v = s.get('velocity');
    return typeof v === 'number' ? Math.max(1, Math.min(127, v | 0)) : 100;
  });
}

export function writeStepVelocity(
  clip: Y.Map<unknown>,
  index: number,
  velocity: number,
): void {
  const arr = clip.get('steps') as Y.Array<Y.Map<unknown>>;
  const step = arr.get(index);
  step.set('velocity', Math.max(1, Math.min(127, Math.round(velocity))));
}

/// Wipe every step's notes + reset velocities to 100. Single
/// transaction so observers see one commit.
export function clearStepSeqClip(p: Project, clip: Y.Map<unknown>): void {
  const arr = clip.get('steps') as Y.Array<Y.Map<unknown>>;
  p.doc.transact(() => {
    for (let i = 0; i < arr.length; i++) {
      const cell = arr.get(i);
      cell.set('notes', 0);
      cell.set('velocity', 100);
    }
  });
}

/// Fill the pattern with a quick groove: a kick-style hit on every
/// 4th step plus 4–6 random off-beat hits at varied velocities.
/// Used by the Randomize button — the goal is a starting point
/// that's audibly musical, not perfect.
export function randomizeStepSeqClip(p: Project, clip: Y.Map<unknown>): void {
  const arr = clip.get('steps') as Y.Array<Y.Map<unknown>>;
  const len = arr.length;
  // Pick two pitches that sit nicely together — root + perfect fifth.
  // Bits map to MIDI offsets above LOW_MIDI (= C3 / 48).
  const rootBit = 1 << 0;        // C3
  const fifthBit = 1 << 7;       // G3
  const octaveBit = 1 << 12;     // C4
  p.doc.transact(() => {
    for (let i = 0; i < len; i++) {
      const cell = arr.get(i);
      let mask = 0;
      let vel = 80;
      if (i % 4 === 0) {
        mask = rootBit;
        vel = 110;
      } else if (Math.random() < 0.35) {
        mask = Math.random() < 0.5 ? fifthBit : octaveBit;
        vel = 60 + Math.floor(Math.random() * 50);
      }
      cell.set('notes', mask);
      cell.set('velocity', vel);
    }
  });
}

export function getBpm(p: Project): number {
  const seg = p.tempoMap.length > 0 ? p.tempoMap.get(0) : null;
  return seg?.bpm ?? 120;
}

export interface LoopRegion {
  startTick: number;
  endTick: number;
}

/// Read the project's transport loop region. Returns `null` when no
/// loop is set or when start/end are invalid.
export function getLoopRegion(p: Project): LoopRegion | null {
  const lr = p.meta.get('loopRegion') as LoopRegion | undefined;
  if (!lr) return null;
  if (typeof lr.startTick !== 'number' || typeof lr.endTick !== 'number') return null;
  if (lr.endTick <= lr.startTick) return null;
  return { startTick: lr.startTick, endTick: lr.endTick };
}

export function setLoopRegion(p: Project, region: LoopRegion | null): void {
  if (region == null) {
    p.meta.delete('loopRegion');
    return;
  }
  if (region.endTick <= region.startTick) {
    p.meta.delete('loopRegion');
    return;
  }
  p.meta.set('loopRegion', {
    startTick: Math.max(0, Math.floor(region.startTick)),
    endTick: Math.max(0, Math.floor(region.endTick)),
  });
}

export function setBpm(p: Project, bpm: number): void {
  if (p.tempoMap.length === 0) {
    p.tempoMap.push([{ tick: 0, bpm, num: 4, den: 4 }]);
    return;
  }
  const seg = p.tempoMap.get(0);
  p.doc.transact(() => {
    p.tempoMap.delete(0, 1);
    p.tempoMap.insert(0, [{ ...seg, bpm }]);
  });
}

export function getWaveform(p: Project, trackIdx = 0): Waveform {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return 'sine';
  const trackId = p.tracks.get(trackIdx);
  const track = p.trackById.get(trackId);
  const instr = track?.get('instrumentSlot') as Y.Map<unknown> | undefined;
  const params = instr?.get('params') as Y.Map<unknown> | undefined;
  const w = params?.get('waveform');
  return w === 'saw' || w === 'square' ? w : 'sine';
}

export function getMasterGain(p: Project): number {
  return (p.meta.get('masterGain') as number | undefined) ?? 1.0;
}

export function setMasterGain(p: Project, gain: number): void {
  p.meta.set('masterGain', Math.max(0, Math.min(1, gain)));
}

/// Phase 7 M4 — inspector mutators for track identity. Name is a
/// free-form string; color is a hex code from the saturated palette
/// in `track-color.ts` (callers should round-robin via
/// `defaultColorForIndex` rather than typing hex by hand).
export function setTrackName(p: Project, idx: number, name: string): void {
  if (idx < 0 || idx >= p.tracks.length) return;
  const id = p.tracks.get(idx);
  p.trackById.get(id)?.set('name', name);
}

export function setTrackColor(p: Project, idx: number, color: string): void {
  if (idx < 0 || idx >= p.tracks.length) return;
  const id = p.tracks.get(idx);
  p.trackById.get(id)?.set('color', color);
}

export function setTrackMute(p: Project, idx: number, mute: boolean): void {
  if (idx < 0 || idx >= p.tracks.length) return;
  const id = p.tracks.get(idx);
  p.trackById.get(id)?.set('mute', mute);
}

export function setTrackSolo(p: Project, idx: number, solo: boolean): void {
  if (idx < 0 || idx >= p.tracks.length) return;
  const id = p.tracks.get(idx);
  p.trackById.get(id)?.set('solo', solo);
}

export function setTrackPan(p: Project, idx: number, pan: number): void {
  if (idx < 0 || idx >= p.tracks.length) return;
  const id = p.tracks.get(idx);
  p.trackById.get(id)?.set('pan', Math.max(-1, Math.min(1, pan)));
}

export function getTrackMute(p: Project, idx: number): boolean {
  if (idx < 0 || idx >= p.tracks.length) return false;
  const id = p.tracks.get(idx);
  return ((p.trackById.get(id)?.get('mute') as boolean | undefined) ?? false);
}

export function getTrackSolo(p: Project, idx: number): boolean {
  if (idx < 0 || idx >= p.tracks.length) return false;
  const id = p.tracks.get(idx);
  return ((p.trackById.get(id)?.get('solo') as boolean | undefined) ?? false);
}

export function getTrackPan(p: Project, idx: number): number {
  if (idx < 0 || idx >= p.tracks.length) return 0;
  const id = p.tracks.get(idx);
  return ((p.trackById.get(id)?.get('pan') as number | undefined) ?? 0);
}

export function getTrackGain(p: Project, idx = 0): number {
  if (idx >= p.tracks.length) return 1;
  const id = p.tracks.get(idx);
  const track = p.trackById.get(id);
  return (track?.get('gain') as number | undefined) ?? 1;
}

export function setTrackGain(p: Project, idx: number, gain: number): void {
  if (idx >= p.tracks.length) return;
  const id = p.tracks.get(idx);
  const track = p.trackById.get(id);
  track?.set('gain', gain);
}

export function setWaveform(p: Project, waveform: Waveform, trackIdx = 0): void {
  if (trackIdx < 0 || trackIdx >= p.tracks.length) return;
  const trackId = p.tracks.get(trackIdx);
  const track = p.trackById.get(trackId);
  const instr = track?.get('instrumentSlot') as Y.Map<unknown> | undefined;
  const params = instr?.get('params') as Y.Map<unknown> | undefined;
  params?.set('waveform', waveform);
}
