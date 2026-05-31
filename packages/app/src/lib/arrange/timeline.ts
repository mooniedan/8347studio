// Phase-12 — shared arrangement-timeline geometry.
//
// Generalized out of AudioTrackView.svelte so the all-tracks
// ArrangementView, its lanes, and (M4) the drag/commit logic all agree
// on tick↔pixel mapping and snapping. The piano-roll and audio editors
// use the same `36px / STEP_TICKS` scale, so blocks line up bar-for-bar
// with the per-track editors.

import {
  STEP_TICKS,
  STEPS_PER_CLIP,
  listBlocksForTrack,
  getAudioRegions,
  getTrackKind,
  type Project,
} from '../project';

/// Pixels per tick — matches the piano-roll/audio grid (`--col-w: 36px`
/// over `STEP_TICKS` ticks per 1/16 cell).
export const PX_PER_TICK = 36 / STEP_TICKS;

/// One 4/4 bar in ticks (16 sixteenth-steps).
export const BAR_TICKS = STEPS_PER_CLIP * STEP_TICKS;

/// Lane row height + the sticky track-header column width + ruler height.
export const LANE_HEIGHT = 44;
export const HEADER_WIDTH = 140;
export const RULER_HEIGHT = 24;

/// Minimum visible span so an empty / short song still fills the view.
const MIN_BARS = 8;

export function tickToPx(tick: number): number {
  return tick * PX_PER_TICK;
}

export function pxToTick(px: number): number {
  return px / PX_PER_TICK;
}

/// Snap a tick to `grid` (defaults to the 1/16 step). Grid-arg'd from
/// the start so M4's drag/move can pass bar/beat/step/off.
export function snapTicks(tick: number, grid: number = STEP_TICKS): number {
  if (grid <= 0) return Math.max(0, Math.round(tick));
  return Math.max(0, Math.round(tick / grid) * grid);
}

/// Furthest tick any block or audio region reaches, rounded up to a
/// whole bar. `floorBars` sets a minimum (the view uses MIN_BARS so an
/// empty song still fills the timeline; the transport uses 1 so the
/// loop matches actual content).
export function songEndTicks(project: Project, floorBars: number): number {
  let max = floorBars * BAR_TICKS;
  for (let t = 0; t < project.tracks.length; t++) {
    if (getTrackKind(project, t) === 'Audio') {
      for (const r of getAudioRegions(project, t)) {
        max = Math.max(max, r.startTick + r.lengthTicks);
      }
    } else {
      for (const b of listBlocksForTrack(project, t)) {
        max = Math.max(max, b.startTick + b.lengthTicks);
      }
    }
  }
  return Math.ceil(max / BAR_TICKS) * BAR_TICKS;
}

/// Arrangement content width (floored at MIN_BARS so the view fills).
export function songTotalTicks(project: Project): number {
  return songEndTicks(project, MIN_BARS);
}

/// The transport loop end that spans the whole arrangement (floored at
/// one bar). Used by M6 to make playback traverse the song.
export function arrangementEndTick(project: Project): number {
  return songEndTicks(project, 1);
}
