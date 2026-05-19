// Project-level MIDI routing.
//
// App.svelte composes a `MidiInputController` callback set out of
// these three handlers — every NoteOn/NoteOff/CC from the
// `createMidiInput` bridge flows through here, where the routing
// rules live:
//   - NoteOn / NoteOff → armed (or fallback-selected) track + the
//     live-recording buffer when arm is on.
//   - CC → Learn capture (highest priority), then a bound parameter
//     lookup in the Y.Doc, then a fall-through to the engine's
//     generic MidiCc handler (sustain pedal, plugin-specific
//     interpretations, etc.).
//
// Keeping the rules here means App.svelte boots one configured
// handler per project instead of inlining the three callbacks.

import { descriptorById, scaleCcToParam, SUBTRACTIVE_DESCRIPTORS } from './plugin-descriptors';
import {
  getMidiBinding,
  getTrackPluginId,
  setSynthParam,
  type Project,
} from './project';
import type { Bridge } from './engine-bridge';

export interface MidiRoutingDeps {
  project: Project;
  bridge: Bridge;
  /// Returns the destination track index for NoteOn/NoteOff and the
  /// CC fall-through. The armed track wins; we fall back to the
  /// currently-selected track so MIDI works "at a glance" when arm
  /// is off.
  routeIdx: () => number;
  isLearnActive: () => boolean;
  /// Stash the CC# for the next Learn-target click.
  capturePendingCC: (cc: number) => void;
  /// Append to the recording buffer when arm is on; no-op otherwise.
  /// The caller decides whether recording is active.
  recordNoteOn: (pitch: number, velocity: number) => void;
  /// Close the open recording entry for `pitch` (if any).
  recordNoteOff: (pitch: number) => void;
}

export interface MidiHandlerSet {
  noteOn: (pitch: number, velocity: number) => void;
  noteOff: (pitch: number) => void;
  cc: (cc: number, value: number) => void;
}

export function buildMidiHandler(deps: MidiRoutingDeps): MidiHandlerSet {
  return {
    noteOn(pitch, velocity) {
      deps.bridge.noteOn(deps.routeIdx(), pitch, velocity);
      deps.recordNoteOn(pitch, velocity);
    },
    noteOff(pitch) {
      deps.bridge.noteOff(deps.routeIdx(), pitch);
      deps.recordNoteOff(pitch);
    },
    cc(cc, value) {
      // 1. Learn mode wins — capture and stop.
      if (deps.isLearnActive()) {
        deps.capturePendingCC(cc);
        return;
      }
      // 2. Bound CC → set the bound parameter via the Y.Doc path so
      //    the change participates in undo/sync.
      const binding = getMidiBinding(deps.project, cc);
      if (binding) {
        const pluginId = getTrackPluginId(deps.project, binding.trackIdx);
        if (pluginId === 'builtin:subtractive') {
          const desc = descriptorById(SUBTRACTIVE_DESCRIPTORS, binding.paramId);
          if (desc) {
            setSynthParam(
              deps.project,
              binding.trackIdx,
              binding.paramId,
              scaleCcToParam(desc, value),
            );
          }
        }
        return;
      }
      // 3. Fall through to the engine's generic MidiCc handler so the
      //    armed track's plugin sees the raw message.
      deps.bridge.midiCc(deps.routeIdx(), cc, value);
    },
  };
}
