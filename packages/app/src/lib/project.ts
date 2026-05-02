import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

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

export async function createProject(): Promise<Project> {
  const doc = new Y.Doc();
  const provider = new IndexeddbPersistence(PROJECT_DOC_NAME, doc);
  const project: Project = attach(doc, () => provider.destroy());
  await provider.whenSynced;

  const legacy = parseLegacyHash();
  if (legacy) {
    seedFromLegacy(project, legacy);
    clearLegacyHash();
  } else if (project.tracks.length === 0) {
    seedDefaults(project);
  }

  return project;
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

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function seedDefaults(p: Project): void {
  p.doc.transact(() => {
    seedMetaAndTempo(p, 120);
    const { trackId } = createMidiTrack(p, 'sine');
    createStepSeqClip(p, trackId, defaultEmptySteps());
  });
}

function seedFromLegacy(p: Project, legacy: LegacyHash): void {
  p.doc.transact(() => {
    seedMetaAndTempo(p, legacy.bpm ?? 120);
    const waveform: Waveform = legacy.waveform ?? 'sine';
    const { trackId } = createMidiTrack(p, waveform);
    const stepNotes = legacy.steps.length === STEPS_PER_CLIP
      ? legacy.steps
      : defaultEmptySteps();
    createStepSeqClip(p, trackId, stepNotes);
  });
}

function seedMetaAndTempo(p: Project, bpm: number): void {
  if (p.meta.size === 0) {
    p.meta.set('name', 'Untitled');
    p.meta.set('sampleRate', 48000);
    p.meta.set('ppq', PPQ);
    p.meta.set('createdAt', Date.now());
  }
  if (p.tempoMap.length === 0) {
    p.tempoMap.push([{ tick: 0, bpm, num: 4, den: 4 }]);
  } else {
    // Replace the first segment's BPM (single-segment in Phase 1).
    const seg = p.tempoMap.get(0);
    p.tempoMap.delete(0, 1);
    p.tempoMap.insert(0, [{ ...seg, bpm }]);
  }
}

function defaultEmptySteps(): number[] {
  return Array<number>(STEPS_PER_CLIP).fill(0);
}

const TRACK_PALETTE = ['#ff8c00', '#3aa9ff', '#7cd64a', '#e34dff', '#ffd84a', '#ff5c8a'];

function createMidiTrack(p: Project, waveform: Waveform): { trackId: string } {
  const trackId = makeId('track');
  const track = new Y.Map<unknown>();

  const params = new Y.Map<unknown>();
  params.set('waveform', waveform);

  const instr = new Y.Map<unknown>();
  instr.set('pluginId', 'builtin:oscillator');
  instr.set('voices', 16);
  instr.set('params', params);

  const idx = p.tracks.length;
  track.set('kind', 'MIDI');
  track.set('name', `Track ${idx + 1}`);
  track.set('color', TRACK_PALETTE[idx % TRACK_PALETTE.length]);
  track.set('mute', false);
  track.set('solo', false);
  track.set('gain', 1.0);
  track.set('pan', 0);
  track.set('instrumentSlot', instr);
  track.set('inserts', new Y.Array());
  track.set('sends', new Y.Array());
  track.set('clips', new Y.Array<string>());

  p.trackById.set(trackId, track);
  p.tracks.push([trackId]);
  return { trackId };
}

function createStepSeqClip(p: Project, trackId: string, stepNotes: number[]): string {
  const clipId = makeId('clip');
  const clip = new Y.Map<unknown>();
  clip.set('kind', 'StepSeq');
  clip.set('trackId', trackId);
  clip.set('startTick', 0);
  clip.set('lengthTicks', STEPS_PER_CLIP * STEP_TICKS);
  clip.set('stepTicks', STEP_TICKS);

  const steps = new Y.Array<Y.Map<unknown>>();
  const cells: Y.Map<unknown>[] = [];
  for (let i = 0; i < STEPS_PER_CLIP; i++) {
    const step = new Y.Map<unknown>();
    step.set('tick', i * STEP_TICKS);
    step.set('notes', stepNotes[i] >>> 0);
    cells.push(step);
  }
  steps.push(cells);
  clip.set('steps', steps);

  p.clipById.set(clipId, clip);

  const track = p.trackById.get(trackId);
  if (track) {
    const trackClips = track.get('clips') as Y.Array<string>;
    trackClips.push([clipId]);
  }

  return clipId;
}

// ---- Legacy URL-hash migration -------------------------------------------

function parseLegacyHash(): LegacyHash | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const s = params.get('s');
  if (!s) return null;

  const steps = decodeLegacySteps(s);
  if (!steps) return null;

  const bpmRaw = params.get('bpm');
  const bpm = bpmRaw && /^\d+(\.\d+)?$/.test(bpmRaw) ? Number(bpmRaw) : null;

  const wRaw = params.get('w');
  const waveform: Waveform | null =
    wRaw === 'sine' || wRaw === 'saw' || wRaw === 'square' ? wRaw : null;

  return { steps, bpm, waveform };
}

function decodeLegacySteps(s: string): number[] | null {
  if (s.length !== STEPS_PER_CLIP * 8) return null;
  const out: number[] = [];
  for (let i = 0; i < STEPS_PER_CLIP; i++) {
    const v = parseInt(s.slice(i * 8, i * 8 + 8), 16);
    if (Number.isNaN(v)) return null;
    out.push(v >>> 0);
  }
  return out;
}

function clearLegacyHash(): void {
  if (typeof window === 'undefined') return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

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

function createPianoRollClip(p: Project, trackId: string): string {
  const clipId = makeId('clip');
  const clip = new Y.Map<unknown>();
  clip.set('kind', 'PianoRoll');
  clip.set('trackId', trackId);
  clip.set('startTick', 0);
  clip.set('lengthTicks', STEPS_PER_CLIP * STEP_TICKS);
  clip.set('notes', new Y.Array<Y.Map<unknown>>());
  p.clipById.set(clipId, clip);
  const track = p.trackById.get(trackId);
  if (track) {
    const trackClips = track.get('clips') as Y.Array<string>;
    trackClips.push([clipId]);
  }
  return clipId;
}

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

/// Insert FX chain helpers — Phase-4 M1. Each insert is a Y.Map with
/// pluginId, params (Y.Map<paramId-string, number>), and bypass.
export type InsertPluginId = 'builtin:gain';

export interface InsertView {
  kind: InsertPluginId;
  params: Record<number, number>;
  bypass: boolean;
}

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
    if (pid !== 'builtin:gain') return;
    const params: Record<number, number> = {};
    const ymap = slot.get('params') as Y.Map<unknown> | undefined;
    ymap?.forEach((v, k) => {
      const id = parseInt(k, 10);
      if (!Number.isNaN(id) && typeof v === 'number') params[id] = v;
    });
    out.push({ kind: 'builtin:gain', params, bypass: Boolean(slot.get('bypass')) });
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
    const params = new Y.Map<unknown>();
    if (kind === 'builtin:gain') params.set('0', 1.0);
    slot.set('params', params);
    arr.push([slot]);
  });
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

export function getBpm(p: Project): number {
  const seg = p.tempoMap.length > 0 ? p.tempoMap.get(0) : null;
  return seg?.bpm ?? 120;
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

export function getWaveform(p: Project): Waveform {
  const trackId = p.tracks.length > 0 ? p.tracks.get(0) : null;
  if (!trackId) return 'sine';
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

export function setWaveform(p: Project, waveform: Waveform): void {
  const trackId = p.tracks.length > 0 ? p.tracks.get(0) : null;
  if (!trackId) return;
  const track = p.trackById.get(trackId);
  const instr = track?.get('instrumentSlot') as Y.Map<unknown> | undefined;
  const params = instr?.get('params') as Y.Map<unknown> | undefined;
  params?.set('waveform', waveform);
}
