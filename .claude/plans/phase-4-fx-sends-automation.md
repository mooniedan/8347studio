# Phase 4 — Effects, sends, automation

## Context

After Phase 3 the user has tracks, instruments, and live input but every
track is dry — no effects, no parallel processing, no time-varying
parameter changes. This phase adds the **insert FX chain**, **send
buses**, **automation lanes**, and **first-party effects** (EQ,
compressor, reverb, delay). It also adds the **container plugin** that
gives Bitwig-style flexibility inside the fixed channel strip
(decision Q3.C).

User-facing verb: **"shape the sound with effects, sends, and
automation."**

## Designs

- **P7 — Automation lane** (curve editor below a track row, what-is-
  automated dropdown, write/read mode): the M4 automation UI
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Automation+Lane.html&via=share)

Note: insert FX slots and send list per-track strip already appear in
the [Mixer View](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Mixer+View.html&via=share)
mockup from Phase 1 — match those affordances when wiring M1–M2 here.

## Milestones

### M1 — Insert FX chain

- TrackEngine gains `inserts: Vec<InsertSlot>`. Each slot has a Plugin
  instance + bypass flag.
- Engine processes track signal in order: `instrument → insert[0] →
  insert[1] → ... → gain/pan/sends → master`.
- Y.Doc: `track.inserts: Y.Array<Y.Map<{ pluginId, params:
  Y.Map<paramId,float>, bypass }>>`.
- UI: `InsertSlots.svelte` — drag-reorder, add/remove, bypass toggle,
  click slot to open plugin panel.
- **Test:** cargo — chain of two test passthrough plugins preserves
  signal; bypass on first plugin skips it; reorder changes processing
  order observably.

### M2 — Bus tracks & send routing

- Track kind `Bus` becomes first-class. Buses have inserts (so a
  reverb-return bus can host the reverb plugin) but no instrument and
  no clips.
- Track gains `sends: Y.Array<Y.Map<{targetTrackId, level, prePost}>>`.
- Engine routing: per audio block, sum sends from each track into target
  bus inputs before bus processing.
- UI: send list per track strip; "create reverb bus" quick action.
- **Test:** cargo — track A with send=1.0 to bus B containing a gain×2
  passthrough → bus output is 2× the input signal magnitude.

### M3 — First-party effects

Each is a `Plugin` impl in `crates/audio-engine/src/plugins/fx/`.

- **EQ** — 4-band parametric (lo-shelf, two peaks, hi-shelf), each band
  has freq/gain/Q/type/enable.
- **Compressor** — threshold, ratio, attack, release, makeup, knee,
  optional sidechain input (named send target).
- **Reverb** — algorithmic (FDN or simple Schroeder), pre-delay, room
  size, damping, mix.
- **Delay** — time, feedback, low/high cut, mix; tempo-synced option
  (subdivision dropdown).
- All four ship with descriptors and host-rendered default UIs (custom
  UIs deferred to Phase 7 or polish).
- **Test:** cargo — per-plugin DSP correctness (e.g. EQ peak gain
  matches at center freq; compressor reduces gain when above threshold;
  delay produces measurable taps at expected sample offsets).

### M4 — Automation lanes

- Y.Doc: `automation: Y.Map<{trackId, paramRef}, Y.Array<{tick, value,
  curve}>>` where `paramRef` = `{ kind: 'instrument'|'insert'|'send'|
  'track', slotIndex?, paramId }`.
- Engine reads automation per audio block: for each automated param,
  evaluate the piecewise curve at current tick range, write resulting
  param value into the plugin via existing param-set path.
- Curve types: `Linear | Hold | Exponential` (S-curve / bezier deferred
  to Phase 9).
- UI: automation lane below each track that can target any param;
  click-drag adds points; drag points to move; right-click changes
  curve type.
- Automation overrides UI knob writes during playback; pause + edit knob
  *creates* an automation point at current tick (Live-style).
- **Test:** cargo — tempo-synced engine renders 4 bars with cutoff
  automation 100→8000 Hz; spectral analysis confirms the cutoff sweep
  shape. Playwright — draw 4-point automation, play, observe knob value
  changes mid-playback.

### M5 — Container plugin

- New first-party plugin: `Container`. Insert slot can hold a Container
  which itself owns a `branches: Vec<Branch>` where `Branch = { mix:
  Plugin chain, gain, pan }`. Branches run in parallel; outputs summed
  back.
- This is the escape hatch for graph-y use cases (parallel compression,
  mid/side, multi-band) without making the host a node-graph editor.
- Container's UI exposes branches as a sub-panel; each branch has its
  own insert chain UI (recursion bounded by complexity, not depth).
- **Test:** cargo — Container with two branches (one identity, one
  ×0.5) sums to 1.5× input; bypass disables.

## Verification (end of phase)

- **Manual:** On a melodic track from Phase 2, add EQ → cut 200Hz mud →
  add compressor → squeeze; create a Reverb bus, send 30% to it; draw
  filter-cutoff automation that opens through the chorus → play →
  hear all of it. Add a Container in one slot, set up parallel
  compression (dry + heavy-comp branch).
- **Automated:**
  - `cargo test -p audio-engine` — per-FX DSP correctness; chain order;
    automation reads.
  - `pnpm playwright test phase-4` — UI flows: add FX, reorder, bypass,
    create bus + send, draw automation.
  - `cargo test offline_render automation_sweep` — render the cutoff-
    sweep test, sha256 baseline.

## Critical files

- `crates/audio-engine/src/plugins/fx/{eq,compressor,reverb,delay}.rs`
- `crates/audio-engine/src/plugins/container.rs`
- `crates/audio-engine/src/automation.rs`
- `crates/audio-engine/src/engine.rs` — routing for inserts + sends.
- `packages/app/src/components/InsertSlots.svelte`,
  `SendList.svelte`, `AutomationLane.svelte`, `BusManager.svelte`.

## Out of scope

- Sidechaining UX polish (named send targets work; UI affordance for
  "use this send as compressor sidechain" is minimal).
- Bezier / S-curve automation → Phase 9.
- LFO / modulation matrix as a first-party "modulator" → consider Phase 9.
- Plugin presets / patch browser → Phase 9.
