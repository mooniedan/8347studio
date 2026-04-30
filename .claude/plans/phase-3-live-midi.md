# Phase 3 — Live MIDI input

## Context

After Phase 2 the user can write notes by mouse but not play them live.
This phase adds **WebMIDI input**, **armed-track routing**, **live
recording**, and **basic MIDI-learn** so a hardware controller can drive
plugin parameters.

User-facing verb: **"plug in a MIDI keyboard, play live, record into a
piano-roll clip."**

## Milestones

### M1 — WebMIDI plumbing

- `packages/app/src/lib/midi-input.ts` — request MIDI access on first
  user gesture; enumerate inputs; subscribe to messages; decode into
  `PluginEvent` (NoteOn/NoteOff/CC).
- UI: device picker in settings; show "MIDI: <device-name>" indicator.
- Browser permission denied / no devices → graceful empty state, no
  errors.
- **Test:** Playwright with WebMIDI mocked — fire NoteOn → assert
  decoded event flows to engine bridge.

### M2 — Armed-track routing

- Y.Doc field `meta.armedTrackId` (single-track for now; multi-arm is
  Phase 9).
- "Arm" toggle on each track strip; only one track armed at a time.
- MIDI input → engine SAB ring with `track_idx` of armed track.
- Clicking arm pre-rolls the instrument (so the first key press isn't
  swallowed by lazy init).
- **Test:** Playwright — arm track 1 → fire mock NoteOn → engine
  reports voice active on track 1; arm track 2 → same NoteOn lands on
  track 2.

### M3 — Live record into clips

- Transport gains a `Record` button (toggle).
- When Record is on AND a track is armed AND playback is running, MIDI
  input streams into a "recording clip" attached to the armed track at
  current tick.
- On Stop, the recording clip is committed to Y.Doc as a normal
  PianoRoll clip and the recording buffer cleared.
- Quantize on commit (optional toggle): snap recorded notes to grid.
- Metronome (optional toggle): click track on each beat.
- **Test:** Playwright with mocked MIDI — start playback, hit Record,
  fire mock notes at tick boundaries, stop → assert PianoRoll clip
  created with those notes at the correct ticks.

### M4 — Basic MIDI-learn

- New mode: "MIDI Learn" toggle in settings.
- When on: every UI parameter knob shows a small target indicator.
- User wiggles a hardware knob → app captures the CC# → user clicks
  any UI parameter → binding stored on Y.Doc:
  `meta.midiBindings: Y.Map<{deviceId, cc} → {trackId?, paramRef}>`.
- Engine + UI both watch bindings; CC messages drive bound params (via
  Y.Doc → SAB).
- "Unbind" affordance per bound param.
- **Test:** Playwright with mocked MIDI CC stream — bind CC#74 to
  filter cutoff → fire CC#74 with values 0..127 → assert cutoff
  param value sweeps.

## Verification (end of phase)

- **Manual:** Plug in a real MIDI keyboard → arm a synth track → play
  live → hear synth → start playback → press Record → play a 4-bar
  riff → press Stop → see the riff appear as a piano-roll clip → play
  back → hear the riff. Bonus: bind a hardware knob to filter cutoff
  via MIDI Learn.
- **Automated:**
  - `pnpm playwright test phase-3` — covers M1–M4 with mocked WebMIDI.
  - Cargo: no new DSP, but engine event-handling tests assert NoteOn/Off
    arrive in the right voice at the right time when injected via the
    bridge's test harness.

## Critical files

- `packages/app/src/lib/midi-input.ts`.
- `packages/app/src/lib/midi-learn.ts`.
- `packages/app/src/components/SettingsPanel.svelte` — device picker,
  MIDI Learn toggle.
- `packages/app/src/components/TrackStrip.svelte` — Arm button.
- `packages/app/src/components/TransportBar.svelte` — Record button,
  metronome toggle.

## Out of scope

- Shareable / per-device controller-map *presets* → Phase 9.
- MIDI output / clock-master → not in dream's main scope.
- Live MIDI streaming between collaborators → optional stretch in
  Phase 8+.
- Multi-arm tracks → Phase 9.
- Take comping / overdub modes → Phase 9.
