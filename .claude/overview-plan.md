# 8347 Studio — Overview Plan

> **Name:** 8347 Studio ("Beat in L33T" — 8=B, 3=E, 4=A, 7=T).
> GitHub: <https://github.com/mooniedan/8347studio>.

This is the high-level phase map and the canonical progress tracker —
the ✓ column reflects current state; bump it when a phase's verification
passes. Each phase is **capability-driven**: the "User can…" column is a
verb the user can do at the end of the phase. Each phase spans the full
stack (engine, data model, UI). Per-phase milestones live in
`.claude/plans/phase-N-*.md`.

The dream is `.claude/dream.md`. The architectural decisions that
underpin every phase are summarized there and were grilled in
`.claude/grill-sessions/2026-04-29-daw-dream.md`. Visual mockups for
every major view live as claude.design artifacts indexed in
`.claude/plans/design-prompts.md`; per-phase plans link the relevant
ones in their own `## Designs` section.

> **Building principle:** every phase ends with something a user can
> stress-test. We don't ship "the engine is done but you can't hear it"
> milestones. Each phase is allowed to refactor earlier phase code as it
> discovers limits — that's the cost of dogfood-driven sequencing, and
> it's the right cost.

---

## Phase map

| ✓  | Phase | User can…                                                                | Core themes                                                                                                     |
|:--:|------:|--------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| ✅ | **0** | Make a single-track polyphonic beat (existing POC).                      | Rust audio-engine, WASM bridge, AudioWorklet, Svelte UI, single oscillator + sequencer                          |
| ✅ | **1** | Make a *multi-track* beat with the step sequencer.                       | Yjs source-of-truth, multi-track engine, tempo, clip-based content model, basic mixer                           |
| ⬜ | **2** | Play a real synth with envelopes and write a piano-roll part.            | Plugin trait, first-party synth (subtractive, ADSR, filter), piano-roll clip, MIDI events                       |
| ⬜ | **3** | Hook up a MIDI keyboard and play live.                                   | WebMIDI input, armed-track routing, live recording into clips, basic CC-learn                                   |
| ⬜ | **4** | Shape the sound with effects, sends, and automation.                     | Insert FX chain, send buses, parameter automation lanes, first-party EQ/comp/reverb/delay, container plugin     |
| ⬜ | **5** | Drag in a sample, record live audio over a beat.                         | Audio track type, audio clip + warp opt-in, OPFS asset store, getUserMedia recording                            |
| ⬜ | **6** | Control playback from a Picture-in-Picture window.                       | Document PIP transport, popup mixer, BroadcastChannel state sync, satellite render contract                     |
| ⬜ | **7** | Load a third-party plugin from a URL.                                    | Public plugin SDK: WASM+JS contract, manifest, sandbox boundary, registry list, example external plugin         |
| ⬜ | **8** | Make a beat with a friend in real time.                                  | y-websocket sync server, awareness (cursors + transport), shared session UI, content-addressed cloud assets     |
| ⬜ | **9** | Polish: controller presets, automation curves, exports, perf, ecosystem. | Controller-map presets, advanced automation curves, project export bundle, plugin registry UX, performance pass |

> **Legend.** ✅ shipped · 🚧 in progress · ⬜ not started. Bump the box
> when a phase's verification passes; per-milestone status lives in
> `.claude/plans/phase-N-*.md`.

Phases 0–5 establish the local-first single-user DAW. Phase 6 unlocks
the multi-window workflow. Phase 7 publishes the SDK. Phase 8 flips the
collab switch (architecture has been ready since Phase 1). Phase 9 is a
forever-phase of ecosystem polish.

---

## Cross-cutting commitments

These are not phases — they're disciplines that must hold from Phase 1
onward. Violating them in an early phase causes painful rework later.

1. **Yjs is the source of truth for project state, even single-user.**
   The audio engine consumes immutable snapshots derived from the Y.Doc.
2. **Audio engine never blocks, never allocates on the audio thread,
   never touches JS objects.** All input via SAB ring or pre-built
   structural snapshots passed by message.
3. **Content-addressed assets in OPFS** from Phase 5 onward; Y.Doc
   stores only hash + metadata.
4. **Plugin trait stays stable.** First-party plugins exercise the trait
   from Phase 2; if the trait turns out wrong, fix it before more
   plugins land.
5. **Tests we trust.** Cargo unit tests for DSP. Playwright for UI.
   Offline-render + audio-snapshot test for end-to-end audio regression.
   Work TDD-style: failing test first, then implementation. When a UI
   surface lands, its Playwright spec lands with it and joins the
   growing regression suite — every later phase must keep the suite
   green.
6. **Each phase has a "verify" section** in its plan with a manual flow
   *and* an automated check.

---

## Phase summaries

### Phase 0 — POC (shipped)

The single-track polyphonic step sequencer that exists today. Plan:
`.claude/plans/phase-0-poc.md`. Listed for completeness; closed.

### Phase 1 — Multi-track foundations

User can: arrange a beat across multiple tracks, each with its own
instrument settings, with proper transport (play/stop/loop), tempo
control, and a basic mixer. Step sequencer becomes a *clip type* on a
*MIDI track*, not the entire app.

Critical seams introduced:
- Y.Doc as project state (replaces ad-hoc URL-hash encoding).
- Multi-track engine: voice pools per track, mix bus, master.
- Clip model: `MIDI track → step-seq clip` is the day-one shape; piano-
  roll clips are stubbed but not editable yet (Phase 2).
- Hybrid state→engine bridge: postMessage for "rebuild," SAB ring for
  events/params (initially: transport, gain, mute).
- Tempo map (constant tempo for now, but stored as a tempo map).
- Mixer UI: per-track gain/pan/mute/solo + master fader.

### Phase 2 — Plugin trait & first synth

User can: write a melodic part in a piano roll on a track that uses a
real subtractive synth with ADSR envelopes and a filter. Step seq still
works; piano roll is now a peer.

Critical seams introduced:
- Plugin trait (Rust): `descriptors / set_param / handle_event /
  process`. First-party plugins implement it directly.
- Plugin instances are owned by the engine; parameter writes use the
  SAB ring; descriptors flow up at load time.
- Piano-roll clip type: editable, snap-to-grid, basic note tools.
- Default plugin UI: host renders knobs/sliders from descriptors. Custom
  UI mounting (web component) is stubbed for Phase 7.

### Phase 3 — Live MIDI input

User can: plug in a MIDI keyboard, arm a track, play live, optionally
record into a piano-roll clip with metronome/quantize.

Critical seams introduced:
- WebMIDI input: device enumeration, message → engine event path.
- Armed-track routing: the armed MIDI track receives input.
- Live record: incoming events stream into a recording clip; on stop,
  the clip is committed to the Y.Doc.
- Basic CC-learn: pick any UI parameter, wiggle a knob, bound. Stored
  per-project; full controller-map presets are Phase 9.

### Phase 4 — FX, sends, automation

User can: stack effects on a track, route to a reverb send bus, draw an
automation lane that opens a filter cutoff over four bars. Use a
container plugin to build a parallel chain in one insert slot.

Critical seams introduced:
- Insert FX chain per track (ordered slots, bypass per slot).
- Send buses (track type `Bus`); pre/post fader.
- Automation lanes per parameter; engine reads automation per audio
  block; UI edits curves.
- First-party FX plugins: EQ, compressor, reverb, delay (all on the
  Plugin trait).
- Container plugin (first-party): hosts a mini parallel/serial FX graph
  in one slot.

### Phase 5 — Audio clips & recording

User can: drag a sample onto an audio track, time-stretch it to project
tempo, record their voice over a beat.

Critical seams introduced:
- Audio track type. Audio clips with `sampleStart` and `warpMode`
  (`Natural | FollowTempo`).
- OPFS asset store: content-addressed by sha256, written via
  FileSystemWritableFileStream.
- `getUserMedia` capture path: stream → OPFS file → on stop, hash and
  insert clip.
- Time-stretch (basic, e.g. WSOLA) for `FollowTempo` clips. Quality
  improvements deferred.

### Phase 6 — Multi-window UX

User can: open Picture-in-Picture transport for always-on-top control;
pop the mixer or piano-roll into a separate window for multi-monitor
work.

Critical seams introduced:
- Document PIP API plumbing: open, share state, focus management.
- Satellite-window contract: render-only, sends commands to root via
  BroadcastChannel.
- Y.Doc replication via BroadcastChannel between root and satellites
  (snapshot + diff stream).

### Phase 7 — Public plugin SDK

User can: paste a plugin URL, the host fetches the manifest, downloads
the WASM+JS, and the plugin shows up in the "add insert" or "add
instrument" picker. Bring-your-own plugin works for arbitrary URLs
(static-hostable; no central app store).

Critical seams introduced:
- Plugin manifest format finalized.
- Plugin loader: fetch, validate, instantiate WASM in engine, mount JS
  UI bundle in a sandbox (custom element + restricted host API).
- Sandbox host API: parameter reads/writes, asset reads, no network.
- Example external plugin (in a separate repo / static-hosted) to prove
  the boundary.

### Phase 8 — Live collaboration

User can: share a project link with a friend, both edit simultaneously,
both see each other's cursor + selection, both have transport in
lockstep, both have access to all referenced audio assets.

Critical seams introduced:
- y-websocket sync server (self-hosted; small).
- Yjs awareness wiring for cursors, selection, transport position.
- Cloud asset bucket: content-addressed object store (S3/R2). Upload on
  record; fetch on first reference. OPFS remains the local cache.
- Presence UI (avatars, "X is editing the bass synth").

### Phase 9 — Polish & ecosystem

Forever-phase. Each item is an independent ticket; pull off the queue
as they become important.

- Shareable controller-map presets (Phase 3 left this as per-project).
- Advanced automation curves: bezier, exponential, S-curve.
- Project export bundle (zip of Y.Doc snapshot + assets) and import.
- Plugin registry UX: "browse plugins" view backed by a curated
  manifest list.
- Performance pass: profile worst-case projects, optimize hot loops,
  audio-thread allocations audit.
- Better time-stretch (élastique-style or phase-vocoder).
- Mobile / touch UX experiments.

---

## How to read a phase plan

Every per-phase plan has the same shape:

```
# Phase N — <Headline verb>

## Context
Why this phase, what the user can do at the end of it, and how it
connects to dream.md and the previous phase.

## Milestones (M1..Mk)
Each milestone:
  - What it adds
  - Critical files / new modules
  - Test / verification (cargo + playwright + audio snapshot where
    relevant)

## Verification (end of phase)
The end-to-end manual test that proves the headline verb works.
The automated check that locks the regression.

## Out of scope
Things that look like they belong here but are deferred to a later phase.
```
