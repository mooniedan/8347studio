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
