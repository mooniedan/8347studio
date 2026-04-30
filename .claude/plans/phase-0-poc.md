# Phase 0 — POC (closed)

## Context

The starting point. A single-track polyphonic step sequencer, Rust audio
engine compiled to WASM, AudioWorklet, Svelte UI. Already shipped per
`PLAN.md` (M1–M6) and the polyphony work landed 2026-04-21.

This phase is listed for completeness so later phases can reference what
existed at start.

## What shipped

- `crates/audio-engine` — `Oscillator` (sine/saw/square), `Sequencer`
  (per-step u32 bitmask of active MIDI notes, 8-voice pool with
  oldest-voice stealing).
- `crates/wasm-bridge` — `#[no_mangle]` exports for `init`, `process`,
  `set_frequency`, `set_gain`, `alloc`. Single global `SEQ` static.
- `packages/app` — Svelte UI: transport, frequency/gain sliders, step
  grid, waveform visualizer (AnalyserNode + Canvas).
- AudioWorklet processor that loads WASM bytes and calls `process`.
- URL-hash project encoding under key `s=` (single-instrument).

## Known limitations to address in Phase 1+

- Single global `SEQ` in `crates/wasm-bridge/src/lib.rs` — must
  generalize to per-track engines.
- Single-instrument URL hash key `s=` — replace with full Y.Doc-backed
  project state.
- Shared single oscillator type — generalize to plugin-trait instruments
  (Phase 2).
- No tempo map; transport assumes one constant tempo encoded ad-hoc.
- No mixer; single track plays direct to `AudioContext.destination`.
- No clip model; "the project" *is* the step pattern.

## Verification (already passing)

- `cargo test -p audio-engine` — DSP unit tests.
- Manual: `just dev` → open browser → make a beat with the step grid →
  hear it → drag frequency slider → pitch changes.

## Status

Closed. Phase 1 begins by generalizing the engine and introducing Yjs.
