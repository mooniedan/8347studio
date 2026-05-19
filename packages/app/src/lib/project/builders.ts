// Internal Y.Doc structure builders.
//
// Shared between the public-API helpers in `./index.ts` (addMidiTrack,
// addSubtractiveTrack, addDrumkitTrack, …) and the seed entry points
// in `./demo.ts` (seedDefaults, seedFromLegacy, seedDemoSong). Keeping
// them in a sibling module avoids a circular import between the two —
// each builder takes the `Project` shape but otherwise doesn't depend
// on the higher-level API.

import * as Y from 'yjs';
import { TRACK_PALETTE } from '../track-color';
import { STEPS_PER_CLIP, STEP_TICKS, type Project, type Waveform } from './index';

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultEmptySteps(): number[] {
  return Array<number>(STEPS_PER_CLIP).fill(0);
}

export function createMidiTrack(
  p: Project,
  waveform: Waveform,
): { trackId: string } {
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

export function createStepSeqClip(
  p: Project,
  trackId: string,
  stepNotes: number[],
): string {
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
    // Phase-10 M1 — per-step velocity, default 100 (matches the
    // legacy fixed-gain trigger). User can drag the velocity lane
    // in Sequencer.svelte to change it.
    step.set('velocity', 100);
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

/// Build an empty PianoRoll clip on `trackId`. Phase-2 M4 introduced
/// these — they replace step-seq clips for instrument tracks that
/// want melodic content rather than a step grid.
export function createPianoRollClip(p: Project, trackId: string): string {
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
