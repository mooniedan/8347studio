# Phase 1 — Multi-track foundations

## Context

Phase 0 left a single-track step sequencer with project state encoded in
the URL hash. This phase generalizes the engine to multiple tracks and
moves project state into a Yjs `Y.Doc`. The user-facing verb is **"make
a multi-track beat with the step sequencer."**

Why now: the dream's collab + plugin SDK + automation work all assume
project state is a Y.Doc and the engine is multi-track. Doing it later
would mean rewriting every milestone in between.

## Milestones

### M1 — Project state in Yjs (single-user)

- Add `yjs`, `y-indexeddb` to `packages/app`.
- Define the project schema in TypeScript: `Project = Y.Doc` with maps
  `meta`, `tempoMap`, `tracks`, `trackById`, `clipById`, `assets`,
  `automation`. Match shape in `dream.md` so later phases extend, not
  reshape.
- Persist via `y-indexeddb`. New file: `packages/app/src/lib/project.ts`.
- Migration: if a URL hash `s=...` is present on first load, decode the
  legacy step pattern and seed a single MIDI track + step-seq clip; then
  drop the hash.
- **Test:** Playwright — load a legacy URL → see seeded track in UI →
  reload → state persists from IndexedDB.

### M2 — Multi-track audio engine (Rust)

- Replace single global `SEQ` in `crates/wasm-bridge/src/lib.rs` with
  `Engine` owning `tracks: Vec<TrackEngine>`.
- `TrackEngine` = `{ instrument: Box<dyn Plugin> (stub), gain, pan, mute,
  solo, voice_pool }`. Plugin trait is a forward-compatible stub that
  Phase 2 fills in; for now the only "instrument" is the existing
  oscillator wrapped behind the trait.
- Master bus: sums tracks, applies master gain, emits stereo to worklet.
- Voice pool stays per-instrument (Q9 decision); add `voices: u32` field
  with default 16, exposed via param.
- **Test:** `cargo test -p audio-engine` — multi-track mix sums correctly,
  mute drops a track, solo isolates.

### M3 — Hybrid bridge: structural + event channels

- Worklet message protocol:
  - Structural (`postMessage`): `RebuildProject(serialized)` —
    flat-binary representation of tracks/clips/etc; engine swaps state
    atomically between audio blocks.
  - Events (SAB ring): `{ kind: NoteOn|NoteOff|SetParam|Transport,
    track_idx, payload }`. Lock-free SPSC ring in `SharedArrayBuffer`.
- `packages/app/src/lib/engine-bridge.ts` — owns the SAB, encoders for
  events, postMessage for rebuild. Subscribes to Y.Doc; on structural
  changes, builds a new snapshot and posts; on parameter writes (gain,
  mute, etc.), emits via the ring.
- COOP/COEP headers in vite config (`crossOriginIsolated`).
- **Test:** Playwright + `console.timeStamp` instrumentation — SetParam
  via SAB lands in engine within one audio block; RebuildProject lands
  before next block boundary.

### M4 — Tempo map & transport

- Add `TempoMap` in audio-engine: `Vec<{ tick, bpm, num, den }>`,
  starts as a single segment.
- Engine maintains a 64-bit `current_tick` advanced per audio block by
  consulting tempo map.
- Transport events (Play, Stop, Locate, Loop on/off, Loop region) flow
  via SAB.
- UI: transport bar with Play/Stop, BPM input (constant tempo for now,
  but stored as a tempo map).
- **Test:** cargo test — given tempo 120, after 2 seconds at 48k SR,
  `current_tick` ≈ 1920 (2 beats × 960 PPQ). Playwright — Play → tick
  display advances; Stop → halts; BPM change recalculates.

### M5 — Clip-based content model

- Step-seq clip becomes a *clip type* on a *MIDI track*. Clip schema in
  Y.Doc: `{ kind: "StepSeq", trackId, startTick, lengthTicks, steps:
  Y.Array<{ tick, notes: u32 }> }`.
- Engine schedules clip events: per audio block, walks active clips on
  each MIDI track and emits NoteOn/NoteOff into the track's instrument.
- Multiple clips per track allowed; clips on different tracks play
  simultaneously.
- UI: track list (left rail), per-track step grid (initially each MIDI
  track shows its first/only StepSeq clip's grid).
- **Test:** Playwright — add second track → second grid appears →
  toggle steps on both → hear both → solo one → only that one plays.

### M6 — Mixer

- New panel: per-track strip with gain slider, pan knob, mute, solo,
  level meter (peak + RMS, fed by AnalyserNodes or engine-side meter
  buffer in SAB).
- Master strip with gain + master meter.
- All mixer params write through Y.Doc; Y.Doc → engine via SAB events
  (M3).
- **Test:** Playwright — drag track 1 gain to 0 → its meter reads
  silence, master meter drops → drag back → restored.

## Verification (end of phase)

- **Manual:** Open the app → add 3 MIDI tracks → set a kick pattern on
  track 1 (StepSeq), hat pattern on track 2, snare on track 3 → adjust
  per-track gain → mute track 2 mid-playback → un-mute → reload page →
  beat returns identically.
- **Automated:**
  - `just test-rust` — all cargo tests pass (multi-track engine).
  - `pnpm playwright test phase-1` — load app, build a 3-track project
    via UI, save (auto via y-indexeddb), reload, assert state matches.
  - `cargo test -p audio-engine offline_render` — render 4 bars of a
    fixed 3-track project to a buffer, assert sha256 matches a baseline
    captured during phase development (audio regression snapshot).

## Critical files (new + modified)

- `packages/app/src/lib/project.ts` — Y.Doc schema, persistence.
- `packages/app/src/lib/engine-bridge.ts` — SAB ring + postMessage.
- `packages/app/src/lib/transport.ts` — transport state.
- `packages/app/src/components/TrackList.svelte`,
  `Mixer.svelte`, `TransportBar.svelte`.
- `crates/audio-engine/src/engine.rs` — top-level multi-track engine.
- `crates/audio-engine/src/track.rs` — `TrackEngine`.
- `crates/audio-engine/src/tempo_map.rs`.
- `crates/audio-engine/src/clip.rs` — step-seq clip scheduling.
- `crates/wasm-bridge/src/lib.rs` — replaces `SEQ` with `Engine`,
  exposes new event-ring + rebuild interface.
- `vite.config.ts` — COOP/COEP headers.

## Out of scope (deferred)

- Plugin trait flesh-out → Phase 2.
- Piano-roll clip type (editable) → Phase 2.
- WebMIDI input → Phase 3.
- Insert FX, sends, automation → Phase 4.
- Audio tracks → Phase 5.
- Tempo *changes* mid-song (the tempo map exists but only one segment
  is created via UI; multi-segment tempo automation is Phase 4).
