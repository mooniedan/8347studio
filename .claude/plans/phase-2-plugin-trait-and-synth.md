# Phase 2 — Plugin trait & first real synth

## Context

After Phase 1 the engine is multi-track but every track plays a stub
oscillator. This phase introduces the **Plugin trait** (the same one
the SDK will publish in Phase 7) and ships the first real instrument: a
polyphonic subtractive synth with full ADSR, a filter, and proper
envelope handling. It also introduces the **piano-roll clip** so users
can write melodic lines, not just step patterns.

User-facing verb: **"play a real synth with envelopes and write a piano-
roll part."**

## Designs

- **P3 — Piano-roll editor** (keyboard rail, note grid, velocity lane,
  inspector): the M4 piano-roll clip UI
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Piano+Roll.html&via=share)
- **P5 — Subtractive synth panel** (osc / filter / amp ADSR / filter
  ADSR sections): both the M2 synth UI *and* the host-rendered default
  template (M3) for any plugin without a custom UI
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Subtractive+Synth.html&via=share)

## Milestones

### M1 — Plugin trait (Rust)

- `crates/audio-engine/src/plugin.rs`:
  ```rust
  pub trait Plugin: Send {
      fn descriptors(&self) -> &[ParamDescriptor];
      fn set_param(&mut self, id: ParamId, value: f32);
      fn handle_event(&mut self, ev: PluginEvent);
      fn process(&mut self, inputs: &[&[f32]],
                 outputs: &mut [&mut [f32]], frames: usize);
      fn reset(&mut self);
  }

  pub enum PluginKind { Instrument, Effect, Container }
  pub struct ParamDescriptor { id, name, min, max, default, unit,
                               curve: Linear|Exp|Db, group }
  pub enum PluginEvent { NoteOn{pitch, vel}, NoteOff{pitch},
                         MidiCc{cc, value}, AllNotesOff }
  ```
- `TrackEngine.instrument: Box<dyn Plugin>`.
- **Test:** trait is object-safe; a stub impl compiles and can be put
  into a Box.

### M2 — Subtractive synth plugin (first-party, statically linked)

- New crate or module: `crates/audio-engine/src/plugins/subtractive.rs`.
- Voice: 2 oscillators (mix), 1 filter (state-variable, low-pass +
  high-pass + band-pass selectable), amp envelope (ADSR), filter
  envelope (ADSR), envelope amount.
- Polyphony via per-instrument voice pool; voice count is a parameter
  (1–128, default 16), oldest-voice stealing.
- Parameter set:
  - Osc A waveform, Osc A detune, Osc B waveform, Osc B detune, Osc mix
  - Filter type, Filter cutoff, Filter resonance, Filter env amount
  - Amp ADSR (4 params), Filter ADSR (4 params)
  - Master gain
- Voice handles `NoteOn` / `NoteOff` correctly; sustain pedal (CC64)
  optional.
- **Test:** cargo — render 1s of `NoteOn(60, 100)` followed by 0.5s of
  `NoteOff(60)`, assert: peak in attack phase, decay to sustain level,
  release tail tapers to silence within release time.

### M3 — Param descriptors → host-rendered default UI

- Engine ships descriptors over postMessage on plugin instantiation.
- `packages/app/src/lib/plugin-host.ts` — keeps a registry of loaded
  plugin instances and their descriptors.
- `packages/app/src/components/PluginPanel.svelte` — given a plugin
  instance, renders a knob/slider/dropdown per descriptor based on
  `curve`/`unit`. Param writes go to Y.Doc → SAB ring → engine.
- Group descriptors by `group` field for layout (Osc, Filter, Env).
- **Test:** Playwright — open synth panel → see knobs for all params →
  twist filter cutoff → hear timbre change → reload → param values
  persist.

### M4 — Piano-roll clip type

- Clip schema variant: `{ kind: "PianoRoll", trackId, startTick,
  lengthTicks, notes: Y.Array<{ pitch, startTick, lengthTicks,
  velocity }> }`.
- Engine clip-scheduler supports both StepSeq and PianoRoll variants
  (Phase 1's scheduler is generalized).
- UI: `PianoRoll.svelte` — keyboard on Y, time on X, click-drag to
  create notes, drag note edges to resize, drag body to move, delete
  with backspace, snap-to-grid (configurable: 1/4, 1/8, 1/16, off).
- Clip switcher per track: choose StepSeq or PianoRoll for each clip.
- **Test:** Playwright — create a piano-roll clip → draw 4 notes (C4
  E4 G4 C5) → play → hear arpeggio → drag G4 up to A4 → re-play →
  hear A4.

### M5 — Custom UI mounting hook (stubbed)

- Define the contract for plugins to ship their own UIs (used in Phase
  7 by third-party plugins): plugin manifest carries a `ui` URL pointing
  at a JS module that exports `createUI(host: PluginHost)
  → HTMLElement`.
- Host API for plugin UIs: `host.getParam(id)`, `host.setParam(id,
  value)`, `host.subscribe(id, cb)`. No DOM access to the rest of the
  app.
- This phase only stubs the integration point; the subtractive synth
  uses host-rendered UI.
- **Test:** unit test of the host API surface.

## Verification (end of phase)

- **Manual:** Add a MIDI track → confirm subtractive synth is the
  default instrument → open piano-roll clip → write a melody → play →
  hear the synth playing the notes with audible attack/decay → tweak
  filter cutoff during playback → hear it sweep.
- **Automated:**
  - `cargo test -p audio-engine` — synth voice ADSR shape; multi-voice
    polyphony; voice stealing under load.
  - `pnpm playwright test phase-2` — create melody, change params,
    reload, state persists; descriptors rendered match plugin schema.
  - `cargo test -p audio-engine offline_render` — render the canonical
    "ode to joy" test melody on the synth, assert sha256 matches
    baseline (audio regression snapshot for the synth itself).

## Critical files (new + modified)

- `crates/audio-engine/src/plugin.rs` — trait, descriptors, events.
- `crates/audio-engine/src/plugins/subtractive.rs` — first synth.
- `crates/audio-engine/src/clip.rs` — generalized for PianoRoll variant.
- `packages/app/src/lib/plugin-host.ts`.
- `packages/app/src/components/PluginPanel.svelte`,
  `PianoRoll.svelte`, `KnobControl.svelte`, `EnvelopeEditor.svelte`.
- `crates/wasm-bridge/src/lib.rs` — descriptors export.

## Out of scope

- Third-party plugin loading (Phase 7).
- Sampler / drum kit instruments (planned in Phase 4 or 5; not strictly
  scoped here).
- Effects (Phase 4).
- LFO / mod matrix (consider for Phase 4 or later).
