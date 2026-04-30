# WASM DAW — Implementation Plan

## M1: Rust oscillator
- Implement `Oscillator` struct in `crates/audio-engine`
- `new(sample_rate)`, `set_frequency()`, `set_gain()`, `process(&mut [f32])`
- **Test:** `cargo test -p audio-engine` — unit tests verify sine output: correct frequency, amplitude, no NaN

## M2: WASM bridge
- `#[no_mangle]` exports in `crates/wasm-bridge`: `init`, `process`, `set_frequency`, `set_gain`, `alloc`
- **Test:** `cargo build -p wasm-bridge --target wasm32-unknown-unknown --release` compiles clean; inspect exports

## M3: AudioWorklet processor
- `packages/app/src/worklet/processor.js` — loads WASM bytes, calls process()
- **Test:** Browser console — register worklet, post WASM bytes, verify `process()` runs

## M4: Audio context + WASM loader
- `packages/app/src/lib/audio.ts` — AudioContext setup, worklet registration, WASM fetch + post
- **Test:** `just build-wasm && just dev` → open browser → call `initAudio()` from console → no errors

## M5: Transport UI
- `Transport.svelte` — Play/Stop button, frequency slider (220–880Hz), gain slider (0–1)
- Wire to `audio.ts` play/stop/setFrequency/setGain
- **Test:** Click Play → hear 440Hz sine → move freq slider → pitch changes → gain → volume changes → Stop → silence

## M6: Visual feedback
- Waveform visualizer using AnalyserNode + Canvas 2D
- **Test:** Play audio → canvas shows live waveform → stop → canvas flatlines
