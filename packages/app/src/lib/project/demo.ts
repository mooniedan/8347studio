// Project seeding + legacy URL-hash migration.
//
// Split out of `./index.ts` because the demo seed alone is ~230
// lines that nothing else in the project module depends on at
// module-load time. Keeps `index.ts` focused on the project shape
// + public CRUD; this file owns the "what comes out of the box"
// content.
//
// The seeds use the public helpers from `./index` (addBusTrack,
// addInsert, addAutomationPoint, …). Module load order:
//   index.ts → loaded first (all exports settled before demo runs)
//   demo.ts   → loaded next, imports work
//   createProject (in index.ts) → calls into demo.ts on user click
// No real circular issue: every use is inside a function body, not
// at top-level evaluation.

import * as Y from 'yjs';
import { TRACK_PALETTE } from '../track-color';
import {
  addAutomationPoint,
  addBusTrack,
  addContainerSubInsert,
  addDrumkitTrack,
  addInsert,
  addMidiTrack,
  addPianoRollNote,
  addSend,
  DRUM_PITCH_CHAT,
  DRUM_PITCH_KICK,
  DRUM_PITCH_OHAT,
  DRUM_PITCH_SNARE,
  getPianoRollClipForTrack,
  getStepSeqClipForTrack,
  PPQ,
  setContainerBranchGain,
  setContainerSubInsertParam,
  setInsertParam,
  setLoopRegion,
  setMasterGain,
  setMidiBinding,
  setSynthParam,
  setTrackColor,
  setTrackGain,
  setTrackPan,
  STEP_TICKS,
  STEPS_PER_CLIP,
  writeStepNotes,
  writeStepVelocity,
  type Project,
  type Waveform,
} from './index';
import {
  createMidiTrack,
  createPianoRollClip,
  createStepSeqClip,
  defaultEmptySteps,
  makeId,
} from './builders';

export interface LegacyHash {
  steps: number[];
  bpm: number | null;
  waveform: Waveform | null;
}

const DEFAULT_LOOP_BARS = 4;
/// Helper — defer the multiply until call time so this module doesn't
/// read `STEPS_PER_CLIP` / `STEP_TICKS` at top-level evaluation. Those
/// live in `./index.ts`, which imports `./demo.ts`; reading them
/// here-and-now races the circular-import init order.
function defaultLoopTicks(): number {
  return DEFAULT_LOOP_BARS * STEPS_PER_CLIP * STEP_TICKS;
}

export function seedDefaults(p: Project): void {
  p.doc.transact(() => {
    seedMetaAndTempo(p, 120);
    const { trackId } = createMidiTrack(p, 'sine');
    createStepSeqClip(p, trackId, defaultEmptySteps());
    setLoopRegion(p, { startTick: 0, endTick: defaultLoopTicks() });
  });
}

export function seedFromLegacy(p: Project, legacy: LegacyHash): void {
  p.doc.transact(() => {
    seedMetaAndTempo(p, legacy.bpm ?? 120);
    const waveform: Waveform = legacy.waveform ?? 'sine';
    const { trackId } = createMidiTrack(p, waveform);
    const stepNotes = legacy.steps.length === STEPS_PER_CLIP
      ? legacy.steps
      : defaultEmptySteps();
    createStepSeqClip(p, trackId, stepNotes);
    setLoopRegion(p, { startTick: 0, endTick: defaultLoopTicks() });
  });
}

/// Seed a "demo song" — a feature-tour project that exercises every
/// shipped DAW capability so a new user can hit Play and immediately
/// hear the engine, and so the project doubles as a manual regression
/// asset. Each numbered block corresponds to a feature category; new
/// features should append a new block rather than mutate existing
/// ones, so the demo grows monotonically.
export function seedDemoSong(p: Project): void {
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
      // Phase-10 M2c — per-bar velocity swell so the new piano-roll
      // velocity lane shows visible variation when ★ Demo Song is
      // loaded. Bar 1 punches in strong; bars 2–3 settle; bar 4
      // pulls back as the turnaround. Within each chord the bass
      // note (lowest semi) is slightly hotter than the upper voices
      // for a touch of voicing balance.
      const V1L = 118, V1U = 108;
      const V2L = 102, V2U = 92;
      const V3L = 95,  V3U = 85;
      const V4L = 80,  V4U = 70;
      // Bar 1: Cm (C, Eb, G).
      addPianoRollNote(p, leadClip, lead(0, 0, CHORD_LEN, V1L));
      addPianoRollNote(p, leadClip, lead(3, 0, CHORD_LEN, V1U));
      addPianoRollNote(p, leadClip, lead(7, 0, CHORD_LEN, V1U));
      // Bar 2: Bb (Bb, D, F).
      addPianoRollNote(p, leadClip, lead(-2, 16, CHORD_LEN, V2L));
      addPianoRollNote(p, leadClip, lead(2, 16, CHORD_LEN, V2U));
      addPianoRollNote(p, leadClip, lead(5, 16, CHORD_LEN, V2U));
      // Bar 3: Ab (Ab, C, Eb).
      addPianoRollNote(p, leadClip, lead(-4, 32, CHORD_LEN, V3L));
      addPianoRollNote(p, leadClip, lead(0, 32, CHORD_LEN, V3U));
      addPianoRollNote(p, leadClip, lead(3, 32, CHORD_LEN, V3U));
      // Bar 4: G (G, B, D) — turnaround.
      addPianoRollNote(p, leadClip, lead(-5, 48, CHORD_LEN, V4L));
      addPianoRollNote(p, leadClip, lead(-1, 48, CHORD_LEN, V4U));
      addPianoRollNote(p, leadClip, lead(2, 48, CHORD_LEN, V4U));
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
      const C = 1 << 0; // C3
      const G = 1 << 7; // G3
      const Eb = 1 << 3;
      const pattern = [C, 0, G, 0, C, 0, G, Eb, C, 0, G, 0, C, 0, G, C];
      pattern.forEach((notes, i) => writeStepNotes(bassClip, i, notes));
      // Phase-10 M1 — varied per-step velocities so the bass groove
      // has an audible accent on the downbeats. Active steps get a
      // velocity > 100 (heavier than the legacy fixed level);
      // ghost-notes drop to ~65 to push them into the background.
      const bassVelocities = [
        120, 100, 95,  100,  // downbeat 1 + & 2
        120, 100, 95,  65,   // downbeat 3, plus the Eb ghost on 7
        110, 100, 95,  100,
        110, 100, 95,  80,
      ];
      bassVelocities.forEach((v, i) => writeStepVelocity(bassClip, i, v));
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
    // each track's role (warm lead, deep bass, effect bus, drums).
    setTrackColor(p, leadIdx,      TRACK_PALETTE[1]); // orange
    setTrackColor(p, bassIdx,      TRACK_PALETTE[5]); // blue
    setTrackColor(p, reverbBusIdx, TRACK_PALETTE[6]); // purple
    setTrackColor(p, drumsIdx,     TRACK_PALETTE[3]); // green

    // 13. Phase-3 M4 — a stored MIDI Learn binding for the lead's
    // filter cutoff (CC#74, the de-facto "cutoff" CC).
    setMidiBinding(p, 74, { trackIdx: leadIdx, paramId: SUB_FILTER_CUTOFF });

    // 14. Phase-5 audio path coverage is added post-seed by
    // App.svelte::enrichDemoSongWithAudioRiser (the WAV is
    // synthesized in-page so we don't bundle a licensed sample).

    void leadId; void bassTrackId; void reverbBusId; void drumsId;
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

// ---- Legacy URL-hash migration ------------------------------------

export function parseLegacyHash(): LegacyHash | null {
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

export function clearLegacyHash(): void {
  if (typeof window === 'undefined') return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
