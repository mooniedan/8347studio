# 8347 Studio — Dream

**Name:** 8347 Studio (read as "Beat in L33T": 8=B, 3=E, 4=A, 7=T).
GitHub: <https://github.com/mooniedan/8347studio>.

A self-contained, in-browser Digital Audio Workstation that lets multiple
people make music together — record, sequence, sample, synthesize, mix,
master, share. Built on a Rust audio engine compiled to WASM, driven by a
sample-accurate AudioWorklet, with an extensible plugin SDK so anyone can
ship a synth or an effect as a static-hostable module.

No time deadline. Build slowly, test frequently, grow steadily. Every phase
must be dogfoodable.

The dream is intentionally maximal. We may never reach every corner. The
point of writing it down is so that early architectural choices leave room
for late capabilities.

---

## Capabilities (the verbs a user can do)

### Composition
- Make a multi-track beat with the existing step sequencer.
- Write melodies in a piano roll with mouse, keyboard, or external MIDI
  controller.
- Layer step-seq + piano-roll clips on the same MIDI track.
- Drag in audio samples and arrange them on audio tracks.
- Record live audio (vocals, guitar, line-in) over a click or playing
  project.
- Record live MIDI from a hardware controller, optionally quantized.
- Loop sections, comp takes, edit at sub-tick precision.
- Time-stretch / warp audio clips to follow the project tempo.
- Edit tempo and time-signature anywhere on the timeline (tempo map).

### Sound design
- Use first-party instruments: a polyphonic subtractive synth (the existing
  oscillator, generalized), a sampler, a drum kit.
- Use first-party effects: EQ, compressor, reverb, delay, distortion,
  chorus, filter.
- Shape any voice with full ADSR envelopes; modulate any plugin parameter
  with LFOs.
- Stack insert FX per track; route to send buses for parallel processing.
- Use a "container" plugin to build mini parallel/serial chains inside one
  insert slot (Bitwig-style escape hatch from the fixed channel strip).

### Mixing
- Per-track gain, pan, mute, solo, with continuous level meters.
- Send buses (FX returns) and group buses.
- Master bus with limiter / final EQ.
- Sidechaining via named send target (compressor key input, etc.).
- Per-parameter automation lanes with curves (linear, exponential, hold).

### Control surfaces & input
- Play instruments live from a WebMIDI keyboard.
- Bind any UI parameter to an external MIDI CC via "MIDI learn."
- Apply shareable controller-map presets (e.g. "APC40," "Launchkey").
- Keyboard shortcuts for transport, tools, common edits.

### Multi-window workspace
- Pin transport + master meters in a Chrome Document Picture-in-Picture
  window so playback can be controlled while another app is foreground.
- Pop any panel (mixer, piano-roll, plugin UI, automation editor) into a
  standalone `window.open` window for side-by-side editing on multi-monitor
  setups.

### Plugins (the SDK)
- Install third-party instruments and effects from a URL — no app-store,
  just static-hosted manifests.
- Plugin authors ship a WASM DSP module + a JS UI bundle; both are
  sandboxed by the host.
- Plugins declare parameter descriptors; the host renders a default UI for
  free, custom UI is opt-in.
- First-party plugins are written against the same trait but compile
  statically into the engine for the fast path.
- Plugin manifests are content-addressed; the same plugin URL is reusable
  across projects.

### Persistence & sharing
- Projects work fully offline; Y.Doc lives in IndexedDB, audio assets live
  in OPFS.
- Export a project as a single bundle (zipped Y.Doc snapshot + referenced
  assets).
- Share a project link that opens a live, collaborative session
  (later phase — architecture day-one ready).

### Collab (later phase)
- Multiple users edit the same project simultaneously, Figma-style.
- Live cursors, selections, and "who's editing what" presence.
- Shared transport: when one user hits Play, everyone's transport advances
  in lockstep (audio rendered locally per client).
- Asset upload happens once to a content-addressed cloud store; other
  clients fetch by hash on first use.
- Conflict-free edits via Yjs CRDT.

### Beyond (explicit stretch goals — not architectural blockers)
- Live-jam mode: stream MIDI events between clients in realtime so a
  remote keyboard can play your synth.
- Audio streaming jam (one user's mic into others' mix via WebRTC).
- Session-view clip launcher (Live-style scenes/grid).
- MIDI clock-out + external-gear support.
- Mobile / touch UX.
- Project versioning / branching ("git for music").

---

## Architecture (the load-bearing decisions)

These are the thirteen decisions made in the
[grill session](grill-sessions/2026-04-29-daw-dream.md). Every phase plan
must respect them. Changing one is a re-grill, not a refactor.

| # | Decision | Choice |
|---|---|---|
| 1 | Scope ceiling | Studio + plugin SDK + multi-user collab |
| 2 | Collab depth | Edit-time edits + shared transport; no audio/MIDI streaming |
| 3 | Audio graph | Fixed channel strip; container plugins for graph-y use cases |
| 4 | Plugin ABI | WASM DSP + JS UI; first-party = same trait, statically linked |
| 5 | CRDT framework | Yjs (project = Y.Doc; awareness = cursors + transport) |
| 6 | State → audio thread | Hybrid: postMessage for structural edits, SAB ring for events/params |
| 7 | Timing | Dual timeline: PPQ ticks (musical) + sample anchor (audio); tempo map maps between |
| 8 | Content model | Strict typed tracks (Audio/MIDI/Bus); step-seq is a MIDI-clip variant |
| 9 | Voice management | Per-instrument resizable pool (1–128, default 16) |
| 10 | Multi-window | Document PIP for transport (1 slot) + `window.open` popups for panels |
| 11 | Audio assets | OPFS local cache + cloud bucket; content-addressed by sha256 |
| 12 | MIDI I/O | WebMIDI input + CC-learn + shareable controller-map presets |
| 13 | Distribution | Local-first first, hosted-collab later (data shapes ready day one) |

---

## Architectural skeleton (where the seams live)

```
┌──────────────────────────────────────────────────────────────────┐
│                     Browser tab (root window)                    │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────────────────────┐    │
│  │   UI (Svelte)    │◄──►│  Y.Doc (project state)           │    │
│  │  Track list,     │    │  Y.Map<TrackId, Track>           │    │
│  │  piano-roll,     │    │  Y.Map<ClipId, Clip>             │    │
│  │  mixer, plugin   │    │  TempoMap, automation, mixer     │    │
│  │  UIs             │    │  Awareness: cursors, transport   │    │
│  └────────┬─────────┘    └──────────┬───────────────────────┘    │
│           │                         │                            │
│           │       structural ops    │ snapshot diffs             │
│           │  (postMessage)          │  (postMessage)             │
│           │                         ▼                            │
│           │                ┌─────────────────────────┐           │
│           └───────────────►│  Engine bridge (JS)     │           │
│                            │  - SAB ring writers     │           │
│                            │  - WebMIDI input        │           │
│                            └────────┬────────────────┘           │
│                                     │ SAB ring (events/params)   │
│                                     │ postMessage (rebuild ops)  │
│                                     ▼                            │
│                            ┌─────────────────────────┐           │
│                            │ AudioWorklet (Rust+WASM)│           │
│                            │  - Tempo / transport    │           │
│                            │  - Track engines        │           │
│                            │  - Plugin host          │           │
│                            │  - Voice pools          │           │
│                            │  - Master bus           │           │
│                            └─────────────────────────┘           │
│                                                                  │
│  ┌───────────────────────┐                                       │
│  │ OPFS (audio assets,   │                                       │
│  │ recordings)           │                                       │
│  └───────────────────────┘                                       │
│                                                                  │
└──────┬───────────────────────────────────────────────────────────┘
       │ BroadcastChannel (Y.Doc updates, transport pos)
       ▼
┌─────────────────────┐    ┌──────────────────────────────────┐
│ Document PIP window │    │  window.open popups              │
│  Transport panel    │    │  Mixer / piano-roll / plugin UI  │
│  Master meter       │    │  (render-only; commands proxied) │
└─────────────────────┘    └──────────────────────────────────┘

Later phases add:
  - y-websocket sync server (collab)
  - Cloud asset bucket (S3/R2, content-addressed)
  - Plugin registry (URL list of plugin manifests)
```

### Project state shape (Yjs)

```
project (Y.Doc)
├─ meta: Y.Map         { name, sampleRate, ppq=960, createdAt, ... }
├─ tempoMap: Y.Array   [{ tick, bpm, num, den }]
├─ tracks: Y.Array     ordered list of TrackId
├─ trackById: Y.Map<TrackId, Y.Map>
│    ├─ kind: "Audio" | "MIDI" | "Bus"
│    ├─ name, color, mute, solo, gain, pan
│    ├─ instrumentSlot: Y.Map  { pluginId, params: Y.Map, voices: int }   (MIDI tracks)
│    ├─ inserts: Y.Array<Y.Map>  [{ pluginId, params: Y.Map, bypass }]
│    ├─ sends: Y.Array<Y.Map>    [{ targetTrackId, level, prePost }]
│    └─ clips: Y.Array<ClipId>
├─ clipById: Y.Map<ClipId, Y.Map>
│    ├─ kind: "PianoRoll" | "StepSeq" | "AudioRegion"
│    ├─ trackId, startTick, lengthTicks
│    ├─ notes: Y.Array (PianoRoll/StepSeq)
│    └─ assetHash, sampleStart, warpMode  (AudioRegion)
├─ automation: Y.Map<{trackId, paramId}, Y.Array<{tick, value, curve}>>
└─ assets: Y.Map<sha256, { url, channels, sampleRate, frames }>
```

### Plugin contract (sketch — finalized in Phase 2)

```rust
// Same trait used by static (first-party) and WASM (third-party) plugins.
pub trait Plugin {
    fn descriptors(&self) -> &[ParamDescriptor];
    fn set_param(&mut self, id: ParamId, value: f32);
    fn handle_event(&mut self, ev: PluginEvent);  // NoteOn, NoteOff, MIDI CC, ...
    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], frames: usize);
    fn voice_count_hint(&self) -> Option<u32> { None }   // for synths
}

// Manifest (third-party):
{
  "name": "Acme Reverb",
  "version": "1.0.0",
  "kind": "effect" | "instrument" | "container",
  "wasm": "https://cdn.example/acme-reverb.wasm",
  "ui":   "https://cdn.example/acme-reverb-ui.js",   // optional
  "params": [...],
  "license": "MIT"
}
```

---

## Anti-goals

- We don't render arbitrary node graphs. Container plugins handle graph-y
  needs; the host stays a fixed channel strip.
- We don't load VST/AU plugins. The plugin SDK is browser-native (WASM+JS).
- We don't run the audio engine in JS. AudioWorklet + Rust/WASM is the only
  fast path.
- We don't bake CRDT merging into the audio thread. Engine consumes
  immutable snapshots.
- We don't mix raw PCM into the project file. Assets are content-addressed
  blobs referenced by hash.
- We don't ship a multi-tenant SaaS as a prerequisite. Local-first first.
- We don't do realtime audio streaming between users. Per-client local
  rendering with shared transport is the collab model.

---

## Working principles

- **Each phase delivers a verb the user can do.** No "the engine is done
  but you can't hear it" milestones.
- **Yjs from the start, even single-user.** Project state lives in a Y.Doc
  on day one so nothing has to be ported when collab phase lands.
- **Content-addressed assets from the start.** Even the single-user
  Phase 1+ stores audio by sha256 in OPFS so the cloud-bucket phase is a
  swap, not a redesign.
- **Plugin trait from the start.** Even before the SDK ships, first-party
  instruments/effects implement the same `Plugin` trait so the SDK is a
  publication step, not a port.
- **Test loops we trust.** Cargo tests for DSP correctness. Playwright
  tests for UI flow. A "render an offline mix and snapshot the audio"
  test for end-to-end audio regression. CI runs all three.
- **Refactors are expected.** Capability-driven phases mean each one will
  reveal limits in the previous one's code. Don't pretend otherwise — plan
  for measured rework, not just additions.
