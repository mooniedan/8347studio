import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { TRACK_PALETTE } from './track-color';

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
  }

  return project;
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

/// Seed a "demo song" — a feature-tour project that exercises every
/// shipped DAW capability so a new user can hit Play and immediately
/// hear the engine, and so the project doubles as a manual regression
/// asset. Each numbered block corresponds to a feature category; new
/// features should append a new block rather than mutate existing
/// ones, so the demo grows monotonically.
function seedDemoSong(p: Project): void {
  // Param ids are stable across plugins; mirror the canonical values
  // here rather than importing the descriptor module to keep this
  // seeder a single self-contained source of truth for the demo.
  const SUB_FILTER_CUTOFF = 6;
  const SUB_FILTER_RES = 7;
  const SUB_AMP_R = 12;
  const SUB_GAIN = 17;
  const EQ_HIGH_GAIN = 9; // 3rd band (lowshelf=0..3, peak=4..7, peak=8..11, ...) — bumps presence
  const COMP_THRESHOLD = 0;
  const COMP_RATIO = 1;
  const REVERB_ROOM = 1;
  const REVERB_MIX = 3;
  const DELAY_TIME = 0;
  const DELAY_FEEDBACK = 1;
  const DELAY_MIX = 4;

  // Pitches built from C minor pentatonic, rooted at C3 (MIDI 48).
  const C3 = 48;
  // Helper note builder. `stepStart` / `stepLen` are 1/16 steps —
  // there are 16 steps per bar, so a chord lasting the full bar uses
  // `stepLen = 16`. Earlier seeds named these params `beat…`; that
  // was misleading, since 1 beat = 4 steps.
  const lead = (semi: number, stepStart: number, stepLen: number, vel = 100) => ({
    pitch: C3 + 12 + semi,
    velocity: vel,
    startTick: stepStart * STEP_TICKS,
    lengthTicks: stepLen * STEP_TICKS,
  });

  p.doc.transact(() => {
    // 1. Tempo + meta.
    seedMetaAndTempo(p, 110);
    p.meta.set('name', 'Demo Song');

    // 2. Lead — Subtractive synth on track 0 with a polyphonic chord
    // progression across 4 bars (showcases polyphony + piano roll).
    // Each chord sustains for 14 steps (3.5 beats); the trailing
    // 2-step gap lets the synth release tail breathe before the next
    // chord. The engine wraps tick_pos at the loop region (see step
    // 11 below) so the lead cycles in lock-step with the drums.
    const PROG_STEPS = 64; // 4 bars × 16 sixteenth-steps
    const CHORD_LEN = 14;  // 3.5 beats — full-bar pad with a small breath
    const leadId = addSubtractiveTrackInner(p, 'Lead');
    const leadIdx = 0;
    const leadClip = getPianoRollClipForTrack(p, leadIdx);
    if (leadClip) {
      (leadClip as Y.Map<unknown>).set('lengthTicks', PROG_STEPS * STEP_TICKS);
      // Bar 1: Cm (C, Eb, G).
      addPianoRollNote(p, leadClip, lead(0, 0, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(3, 0, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(7, 0, CHORD_LEN));
      // Bar 2: Bb (Bb, D, F).
      addPianoRollNote(p, leadClip, lead(-2, 16, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(2, 16, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(5, 16, CHORD_LEN));
      // Bar 3: Ab (Ab, C, Eb).
      addPianoRollNote(p, leadClip, lead(-4, 32, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(0, 32, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(3, 32, CHORD_LEN));
      // Bar 4: G (G, B, D) — turnaround.
      addPianoRollNote(p, leadClip, lead(-5, 48, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(-1, 48, CHORD_LEN));
      addPianoRollNote(p, leadClip, lead(2, 48, CHORD_LEN));
    }
    // Synth voicing — punchier than defaults.
    setSynthParam(p, leadIdx, SUB_FILTER_CUTOFF, 1200);
    setSynthParam(p, leadIdx, SUB_FILTER_RES, 0.25);
    setSynthParam(p, leadIdx, SUB_AMP_R, 0.6);
    setSynthParam(p, leadIdx, SUB_GAIN, 0.4);

    // 3. Bass — Oscillator (saw) step-seq on track 1.
    const bassTrackId = addMidiTrack(p, 'saw');
    const bassIdx = 1;
    const bassTrack = p.trackById.get(bassTrackId);
    bassTrack?.set('name', 'Bass');
    const bassClip = getStepSeqClipForTrack(p, bassIdx);
    if (bassClip) {
      // 16-step pattern: root on 1 & 3, fifth on 2 & 4, octave fill.
      // Bit k = note (LOW_MIDI + k) where LOW_MIDI = 48 (C3).
      // We want C2 (-12 from C3 baseline) — use the 0th bit for
      // baseline (C3) and the lower octave is the same pitch class.
      // For simplicity in step-grid land we emphasize C3 & G3:
      const C = 1 << 0; // C3
      const G = 1 << 7; // G3
      const Eb = 1 << 3;
      const pattern = [C, 0, G, 0, C, 0, G, Eb, C, 0, G, 0, C, 0, G, C];
      pattern.forEach((notes, i) => writeStepNotes(bassClip, i, notes));
    }
    setTrackPan(p, bassIdx, -0.15);

    // 4. Reverb bus — track 2.
    const reverbBusId = addBusTrack(p, 'Reverb Bus');
    const reverbBusIdx = 2;
    addInsert(p, reverbBusIdx, 'builtin:reverb');
    setInsertParam(p, reverbBusIdx, 0, REVERB_ROOM, 0.85);
    setInsertParam(p, reverbBusIdx, 0, REVERB_MIX, 1.0); // wet bus

    // 5. Sends from lead + bass into the reverb bus.
    addSend(p, leadIdx, reverbBusId, 0.35);
    addSend(p, bassIdx, reverbBusId, 0.18);

    // 6. Insert FX chain on the lead — EQ + Compressor for tone shaping.
    addInsert(p, leadIdx, 'builtin:eq');
    setInsertParam(p, leadIdx, 0, EQ_HIGH_GAIN, 3); // +3 dB high band
    addInsert(p, leadIdx, 'builtin:compressor');
    setInsertParam(p, leadIdx, 1, COMP_THRESHOLD, -16);
    setInsertParam(p, leadIdx, 1, COMP_RATIO, 3);

    // 7. Container / parallel routing on the lead — proves the parallel
    // plugin slot wiring. Branch 1 has a delay; branch 2 is dry-ish.
    addInsert(p, leadIdx, 'builtin:container');
    setContainerBranchGain(p, leadIdx, 2, 0, 0.7);
    setContainerBranchGain(p, leadIdx, 2, 1, 0.5);
    addContainerSubInsert(p, leadIdx, 2, 0, 'builtin:delay');
    setContainerSubInsertParam(p, leadIdx, 2, 0, 0, DELAY_TIME, 375);
    setContainerSubInsertParam(p, leadIdx, 2, 0, 0, DELAY_FEEDBACK, 0.3);
    setContainerSubInsertParam(p, leadIdx, 2, 0, 0, DELAY_MIX, 0.4);

    // 8. Automation — sweep the lead's filter cutoff over the 4-bar
    // loop. The engine wraps tick_pos at the loop region so this lane
    // re-evaluates from the start each iteration.
    const progTicks = PROG_STEPS * STEP_TICKS;
    addAutomationPoint(p, leadIdx, 'instrument', 0, SUB_FILTER_CUTOFF, { tick: 0, value: 600 });
    addAutomationPoint(p, leadIdx, 'instrument', 0, SUB_FILTER_CUTOFF, { tick: progTicks / 2, value: 4000 });
    addAutomationPoint(p, leadIdx, 'instrument', 0, SUB_FILTER_CUTOFF, { tick: progTicks - 1, value: 1500 });

    // 9. Mixer state — pan + gain to make the stereo field non-trivial.
    setTrackPan(p, leadIdx, 0.1);
    setTrackGain(p, leadIdx, 0.85);
    setTrackGain(p, bassIdx, 0.9);
    setTrackGain(p, reverbBusIdx, 0.7);
    setMasterGain(p, 0.85);

    // 10. Transport loop — wrap the playhead at 4 bars so every
    // track loops together (the StepSeq bass cycles internally; the
    // engine's tick wrap makes the PianoRoll lead and the cutoff
    // automation cycle in lock-step with it).
    setLoopRegion(p, { startTick: 0, endTick: progTicks });

    // 11. Phase-8 M2 — drum track. 4-bar pattern: kick on beats 1+3,
    // snare on the backbeat (2+4), closed hi-hat 8th-note off-beats,
    // one open-hat splash on the very last off-beat for a turnaround
    // cue. Drumkit uses a PianoRoll clip — the existing ClipScheduler
    // fires NoteOn at the drum-map pitches into the instrument.
    const drumsId = addDrumkitTrack(p, 'Drums');
    const drumsIdx = 3;
    const drumsClip = getPianoRollClipForTrack(p, drumsIdx);
    if (drumsClip) {
      (drumsClip as Y.Map<unknown>).set('lengthTicks', PROG_STEPS * STEP_TICKS);
      const drumHit = (pitch: number, step: number, vel: number) =>
        addPianoRollNote(p, drumsClip, {
          pitch,
          velocity: vel,
          startTick: step * STEP_TICKS,
          lengthTicks: STEP_TICKS, // length is decorative; hits are one-shots
        });
      // Kick — 1+3 of each bar (8 hits over 4 bars).
      for (let bar = 0; bar < 4; bar++) {
        drumHit(DRUM_PITCH_KICK, bar * 16 + 0, 110);
        drumHit(DRUM_PITCH_KICK, bar * 16 + 8, 110);
      }
      // Snare — backbeat (8 hits).
      for (let bar = 0; bar < 4; bar++) {
        drumHit(DRUM_PITCH_SNARE, bar * 16 + 4, 100);
        drumHit(DRUM_PITCH_SNARE, bar * 16 + 12, 100);
      }
      // Closed hat — off-beat 8ths (steps 2, 6, 10, 14 of each bar).
      // Skip the last off-beat of bar 4 to leave room for the open hat.
      for (let bar = 0; bar < 4; bar++) {
        for (const offBeat of [2, 6, 10, 14]) {
          if (bar === 3 && offBeat === 14) continue;
          drumHit(DRUM_PITCH_CHAT, bar * 16 + offBeat, 80);
        }
      }
      // Open hat — final off-beat of bar 4 (step 62).
      drumHit(DRUM_PITCH_OHAT, 3 * 16 + 14, 90);
    }
    setTrackGain(p, drumsIdx, 0.95);

    // 12. Phase-7 M3 — semantic per-track color identity. Override
    // the default round-robin colors with palette entries that match
    // each track's role (warm lead, deep bass, effect bus, drums) so
    // the user can see customizable color stripes at first glance.
    setTrackColor(p, leadIdx,      TRACK_PALETTE[1]); // orange
    setTrackColor(p, bassIdx,      TRACK_PALETTE[5]); // blue
    setTrackColor(p, reverbBusIdx, TRACK_PALETTE[6]); // purple
    setTrackColor(p, drumsIdx,     TRACK_PALETTE[3]); // green

    // 12. Phase-3 M4 — a stored MIDI Learn binding for the lead's
    // filter cutoff (CC#74, the de-facto "cutoff" CC). Plug in any
    // MIDI controller, twist the cutoff knob, and the lead opens up
    // without first using the Learn workflow.
    setMidiBinding(p, 74, { trackIdx: leadIdx, paramId: SUB_FILTER_CUTOFF });

    // 13. (deferred) Audio track / OPFS region. Phase-5 audio assets
    // need a sample shipped with the app; deciding what to bundle
    // (size, licensing) is a separate task. When the sample is in
    // place: addAudioTrack + addAudioRegion here.

    // Suppress unused-var warnings on returned ids; the indexes drive
    // the demo, not the ids.
    void leadId;
    void bassTrackId;
    void reverbBusId;
    void drumsId;
  });
}

/// Internal — same as the public addSubtractiveTrack but lets the
/// caller pick the track name. addSubtractiveTrack hard-codes
/// "Synth N" which would be misleading for the demo.
function addSubtractiveTrackInner(p: Project, name: string): string {
  const id = makeId('track');
  const track = new Y.Map<unknown>();
  const params = new Y.Map<unknown>();
  const instr = new Y.Map<unknown>();
  instr.set('pluginId', 'builtin:subtractive');
  instr.set('voices', 16);
  instr.set('params', params);

  const idx = p.tracks.length;
  track.set('kind', 'MIDI');
  track.set('name', name);
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
  return id;
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
