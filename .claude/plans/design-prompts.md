# Design prompts for 8347 Studio

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?via=share

A series of paste-ready prompts for [claude.design](https://claude.design)
to mock up every major view in the dream. Each prompt body lives in a
fenced code block — click the copy button (or select the block contents)
and paste straight into claude.design, no cleanup required.

Run them in order. P0 establishes the visual system that later prompts
inherit; if a prompt's output is too dense or too vague, split it (one
component at a time) and re-prompt.

---

## P0. Global style & visual system (run this first)

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=8347+Studio.html&via=share



```text
Design the visual system for "8347 Studio", an in-browser Digital Audio
Workstation. The name is "Beat in L33T" (8=B, 3=E, 4=A, 7=T) — there's a
subtle hacker/leet undertone but the surface stays serious-tool, not
gimmicky.

Aesthetic: dark-first, dense, professional. Think the elegance of Linear
or Figma applied to the density of Bitwig Studio or Ableton Live.
Space-efficient, every pixel earns its place. Generous use of small
monospaced numerics (BPM, tick counters, Hz, dB). Color is semantic:
tracks are individually colorable; meters use green→amber→red;
selections use a single accent color; everything else is grayscale.

Deliver:
1. A color palette with --bg-0 through --bg-3 (darkest to surface),
   --fg-0 through --fg-3 (text + muted), one accent color, and semantic
   tokens (--meter-ok, --meter-warn, --meter-clip, --rec, --arm,
   --solo, --mute).
2. A type scale: a sans-serif for UI (e.g. Inter), a monospaced for
   numerics (e.g. JetBrains Mono), 5 sizes from 10px to 16px.
3. Component tokens: knob, slider, button, segmented control, meter
   bar, fader, ghost-button, icon button.
4. A spacing scale (2 / 4 / 8 / 12 / 16 / 24).
5. An app frame: top transport bar (48px), left track-list rail
   (sidebar), main timeline canvas, right inspector (collapsible),
   bottom mixer drawer (collapsible).

One reference screenshot composition showing all of it together.
```

---

## P1. App shell — main arrangement view

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Arrangement+View.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the primary "arrangement view": the screen a producer sees most
of the time.

Layout:
- Top transport bar: Play/Stop/Record buttons, Loop toggle, BPM input
  (mono numerics, click-and-drag to adjust), time-signature, tick/bar
  counter, master meter (stereo, peak + RMS), settings cog,
  collaborator avatars (right-aligned), Pop-to-PIP button.
- Left rail: scrollable track list. Each entry shows: color stripe,
  track name, kind icon (MIDI / Audio / Bus), Mute/Solo/Arm pills,
  tiny meter, height resizer.
- Main canvas: horizontal timeline at top (bars/beats grid), each
  track is a horizontal lane below, clips drawn as colored rounded
  rectangles spanning their duration. Playhead is a vertical line
  with the current bar.beat displayed.
- Right inspector: shows the selected clip or track; collapsible.
- Bottom drawer: minimized mixer summary; click to expand.

Show 8 tracks total: Kick (MIDI), Snare (MIDI), Hat (MIDI), Bass
(MIDI), Lead Synth (MIDI), Vocal (Audio), Reverb Bus (Bus), Master
(Bus). Show MIDI clips as small note-glyph rectangles, audio clips
with embedded waveform thumbnails.
```

---

## P2. Step-sequencer clip (inline, expanded)

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Step+Sequencer.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the step-sequencer clip editor for 8347 Studio. This appears
when a user double-clicks a step-seq clip on a MIDI track in the
arrangement view: the clip expands inline below its row to reveal a
step grid.

Grid: 16 steps × N pitch rows (selectable: 1 row drum / 12 rows
chromatic / custom note set). Filled cells are dots in the track's
color; empty cells are subtle dashed outlines. Velocity per step shown
as cell brightness or a tiny bar.

Above the grid: clip name, length (steps), bar/beat resolution
selector (1/16, 1/32 etc.), randomize, clear. Below: a strip of
per-step velocity/probability bars and a swing slider.

Show the same drum pattern that appears in the arrangement-view kick
track from P1, expanded.
```

---

## P3. Piano-roll editor

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Piano+Roll.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the piano-roll editor for 8347 Studio MIDI clips, occupying the
main canvas (replacing the arrangement view temporarily) when a piano-
roll clip is opened.

- Vertical: full piano keyboard on the left (white/black rows), C
  markers labelled.
- Horizontal: bars/beats grid with subdivisions visible at zoom.
- Notes: rounded rectangles in the track color, opacity = velocity,
  resize handles on edges.
- Top toolbar: tool picker (pencil, select, slip, mute), snap-to-grid
  selector, quantize button, length input.
- Bottom: velocity lane — vertical bars, one per note.
- Right: inspector with selected-note properties (start tick, length,
  pitch, velocity, channel).

Show a 4-bar lead melody with ~16 notes including a held chord on beat
3 of bar 4.
```

---

## P4. Mixer view

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Mixer+View.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the mixer view for 8347 Studio — appears when the bottom drawer
is fully expanded.

Each track gets a vertical channel strip with (top to bottom):
- Track color stripe + name
- Insert FX slots (4 visible, "+" to add) — small rectangles with
  plugin name + bypass dot
- Send list (2–4 visible) — labelled with target bus
- Pan knob
- Big fader with dB scale
- Stereo meter beside fader (peak + RMS, hold-line on peak)
- Solo / Mute / Arm / Record-arm buttons
- Numeric output dB readout (mono font)

Master strip on the right is wider with a master limiter slot and a
bigger meter. Show the same 8 tracks from P1 — Kick to Master.
```

---

## P5. Plugin panel — subtractive synth

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Subtractive+Synth.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the plugin UI for the first-party "Subtractive Synth" in 8347
Studio. Host-rendered (so this is also the template for any plugin that
doesn't ship a custom UI).

Layout: a single panel ~640×400px, grouped into sections:
- Oscillators: two oscs side-by-side, each with waveform picker
  (sine/saw/square/triangle), detune (cents), level. Mix knob between.
- Filter: type selector (LP / HP / BP), cutoff (large knob), resonance,
  env-amount.
- Amp envelope: ADSR — four small sliders or a draggable shape editor
  showing the envelope curve.
- Filter envelope: ADSR (same component as amp).
- Master: gain, voice count (1–128), polyphony mode (poly/mono/legato).

Knobs are circular with a small numeric value below. Active value is
shown in mono font. Section headers in muted small-caps.

Show a "factory bass preset" — sub-saw, low cutoff, fast attack, long
release. The preset name is visible at the top.
```

---

## P6. Audio clip + waveform region

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Audio+Clip+View.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the audio-clip view for 8347 Studio: how an audio region looks
on an Audio track in the arrangement view, and what its inline editor
shows.

Region appearance: full waveform thumbnail rendered into a rounded
rectangle in the track color. Fade-in and fade-out drawn as
diagonal-edge overlays at corners. Trim handles on left/right edges.

Inline editor (when selected): shows in the right inspector — fade
times, gain, "Follow tempo" toggle, original BPM input, sample-
start/end trim sliders, reverse, loop, audio quality (warp algo).

Show two regions: a 4-bar drum loop (Follow Tempo on, originally
120BPM) and a 1-bar vocal phrase (Follow Tempo off).
```

---

## P7. Automation lane

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Automation+Lane.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design an automation-lane editor for 8347 Studio. Appears below a track
in the arrangement view when the user enables automation editing for
one of its parameters.

Lane height: roughly 1/3 the track height. Curve drawn as a polyline +
points; points are draggable; curve segments can be linear / hold /
exponential (right-click point to change).

Top of lane: dropdown of "what's automated" (e.g. "Filter Cutoff —
Bass — Insert 1: Subtractive Synth"), bypass toggle, write/read mode
button.

Show 4 bars of a filter-cutoff sweep that opens linearly from 200Hz to
8kHz across bars 1–3, then drops back exponentially in bar 4.
```

---

## P8. PIP transport window

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=PiP+Transport.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the always-on-top Picture-in-Picture transport window for 8347
Studio. Document PIP API — small, focused, no chrome.

Size: 320 × 96 px. Contents: Play/Stop/Record, current bar.beat in big
mono numerics, BPM, master stereo meter, project name, "return to app"
icon. That's it. Should look great when half the user's screen is a
code editor or video conference.
```

---

## P9. Plugin picker / installer

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Add+Plugin+Picker.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the "add plugin" picker for 8347 Studio. Two modes in one view,
separated by tabs.

Tab 1 — Installed: grid of plugin cards: icon, name, kind (instrument
/ effect / container), version, "Add to track" button.

Tab 2 — Browse / Install from URL: top: URL input ("paste plugin
manifest URL"). Below: a curated registry list (cards), each with an
"Install" button. Every card shows: icon, name, author, version,
license, short description, integrity-verified checkmark.

Style: a marketplace feel but on the dark 8347 Studio palette.
```

---

## P10. Live collaboration — presence & shared transport

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Collaboration+View.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the collaboration affordances for 8347 Studio. These overlay the
existing arrangement / piano-roll views — show one composite mockup
that demonstrates them all.

- Top-right collaborator avatars (3 users, each a colored circle with
  initial). Hover reveals a tooltip with the user name.
- Each user has an assigned color. Their cursor in the piano-roll is a
  faint vertical line + name label. Their selected clip in the
  arrangement view has a colored ring.
- "Following" indicator on the transport bar when another user is the
  transport host.
- A small "X is editing the Bass synth" toast bottom-left.
- Awareness colors propagate to mixer strips: a strip another user is
  twiddling shows a faint colored border.

Show a piano-roll view with the local user editing a melody while a
remote user (avatar "AS", color teal) is editing a different note in
the same clip with their cursor visible.
```

---

## P11. Recording state — armed track

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Live+Recording+States.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the visual states for live recording in 8347 Studio. Show one
composite mockup with three tracks at different states:

1. Armed-not-recording: track strip + arrangement row glow with a
   subtle red outline, a recording dot pulses on the strip.
2. Recording (this is the take): red is solid; a "growing" clip
   rectangle fills in real-time on the arrangement row in a striped
   pattern, ending at the playhead.
3. Idle: normal.

Top transport: Record button is solid red. Tick counter advances.
Metronome icon is on. Show the input source name on the armed track
strip.
```

---

## P12. Settings / MIDI device + controller-map

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Settings+-+MIDI.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the settings panel for 8347 Studio, with the MIDI tab open.

- Section "Input devices": list of MIDI input devices (some connected,
  some remembered-not-connected); active indicator; per-device enable
  toggle.
- Section "Controller maps": list of installed maps (e.g. "APC40",
  "Launchkey 49"), one is active. Apply / remove / import buttons.
- Section "MIDI Learn": toggle "MIDI Learn mode"; below, a list of
  active project bindings: `CC#74 (Launchkey) → Filter Cutoff (Bass /
  Subtractive Synth)` with an unbind button.
- Empty state: "No MIDI devices connected. Plug in a controller and
  it'll appear here."
```

---

## P13. Project export / share

https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Share+Export+Modal.html&via=share

```text
Use the 8347 Studio visual system established in P0:
- dark-first, dense, professional — Linear/Figma elegance applied to
  Bitwig/Ableton density;
- mono numerics for BPM, dB, Hz, tick counters;
- per-track color stripes; meters green→amber→red; one accent color
  for selection; everything else grayscale;
- compact spacing scale (2 / 4 / 8 / 12 / 16 / 24);
- app frame: top transport bar (48px), left track-list rail, main
  timeline canvas, right inspector (collapsible), bottom mixer drawer
  (collapsible).
[Paste your saved P0 token output here for tighter consistency.]

Design the share & export modal for 8347 Studio.

- Share live (collab): room URL with copy button, "Anyone with the
  link can edit", connected collaborators list.
- Export bundle: filename input, "Include audio assets" toggle (default
  on), estimated file size, Export button.
- Render to audio: format (WAV/FLAC/MP3), sample rate, bit depth,
  "Render selection" / "Render entire project" toggle, dry run shows
  expected duration. Render button.
```

---

## P14. System architecture diagram

```text
Draw a comprehensive system-architecture diagram for "8347 Studio", an
in-browser Digital Audio Workstation. This is a technical reference
diagram, not a UI mockup — clarity and information density over
aesthetics, but use the same dark, professional palette as the rest of
the app (dark background, monospaced labels for types and message
names, per-layer accent colors).

The application is local-first, runs entirely in the browser, with an
optional collaboration server. The architecture has these distinct
layers and processes — show each as a clearly bounded region with the
named modules inside:

LAYER 1 — Browser main thread (Svelte UI):
- Components: TransportBar, TrackList, Mixer, PianoRoll, StepSeqClip,
  ArrangementCanvas, Inspector, PluginPanel, PIPWindow.
- State: project.ts (Y.Doc — single source of truth) with sub-maps
  meta / tempoMap / tracks / trackById / clipById / assets / automation.
- Persistence: y-indexeddb provider (local) ↔ y-websocket provider
  (cloud, Phase 8).
- Bridge: engine-bridge.ts (Y.Doc observer → snapshot builder →
  postMessage; UI param writes → SAB ring writer).
- WebMIDI input adapter (Phase 3).
- getUserMedia capture adapter (Phase 5).

LAYER 2 — AudioWorkletGlobalScope (audio thread):
- AudioWorkletProcessor (`processor.js`) hosts the WASM engine.
- Receives `RebuildProject(postcard bytes)` via postMessage, swaps
  state atomically between blocks.
- Reads a SPSC SharedArrayBuffer ring of events
  (NoteOn/NoteOff/SetParam/Transport) every block.
- Writes meters back via a separate SAB region.

LAYER 3 — Rust audio engine (compiled to WASM, runs inside the
worklet):
- crates/audio-engine: Engine → Vec<TrackEngine> → { Plugin instrument,
  voice_pool, gain/pan/mute/solo, inserts: Vec<Plugin>, sends }.
- TempoMap, ClipScheduler (StepSeq + PianoRoll), AutomationReader,
  MasterBus.
- Plugin trait (descriptors / set_param / handle_event / process) —
  first-party plugins implement directly; third-party plugins (Phase 7)
  are loaded as separate WASM modules via the Plugin SDK.
- crates/wasm-bridge: #[no_mangle] exports init / process /
  push_event / rebuild_project.
- Snapshot wire format in audio-engine/src/snapshot.rs (postcard).
- Offline render path (audio-engine/src/offline.rs) used by tests
  outside the worklet.

LAYER 4 — Storage & assets:
- OPFS: content-addressed asset store (sha256 → blob), Phase 5 onward.
- IndexedDB: y-indexeddb persistence of the Y.Doc.
- LocalStorage: small UI prefs only.

LAYER 5 — Optional satellite windows (Phase 6):
- Document PIP transport window, popup mixer, popup piano-roll.
- BroadcastChannel sync of Y.Doc snapshot + diff stream from root tab.
- Render-only; commands flow back to root.

LAYER 6 — External / cloud (Phase 8+):
- y-websocket sync server (Yjs awareness + doc updates).
- Cloud asset bucket (S3/R2, content-addressed).
- Plugin registry (static manifest list, fetched on demand by Phase 7
  plugin picker).

DATA FLOWS — draw labelled arrows for each:
1. UI edit → Y.Doc transaction → y-indexeddb write (local) + (optional)
   y-websocket broadcast → engine-bridge observer → either:
   a. Structural change → postcard-encoded snapshot → postMessage to
      worklet → engine swap.
   b. Param/event change → encoded SAB ring write → engine reads next
      block.
2. WebMIDI device → main thread adapter → SAB ring → engine
   (Phase 3+).
3. Engine → SAB meter buffer → main thread reader → Mixer meters.
4. getUserMedia stream → main thread → OPFS asset write → on stop,
   sha256 hash → Y.Doc clip insert (Phase 5+).
5. Root tab Y.Doc → BroadcastChannel → satellite window Y.Doc replica
   (Phase 6+).
6. Plugin URL → fetch manifest → fetch WASM + JS bundle → sandbox
   instantiate (worklet for DSP, custom element for UI) (Phase 7+).

PHASE LEGEND: color or annotate each module with the phase it lands in
(0–9), so the diagram doubles as a roadmap. Phase 0 modules: existing
oscillator + sequencer. Phase 1 modules: Y.Doc, engine-bridge, multi-
track Engine, TempoMap, MasterBus. Phase 2: Plugin trait + first synth.
Phase 3: WebMIDI. Phase 4: inserts/sends/automation. Phase 5: OPFS +
audio clips + recording. Phase 6: satellite windows. Phase 7: plugin
SDK + sandbox. Phase 8: y-websocket + cloud assets.

CRITICAL invariants to label on the diagram with callouts:
- "Audio thread never allocates, never blocks, never touches JS
  objects" — point at the engine box.
- "Y.Doc is the single source of truth for project state, even
  single-user" — point at the Y.Doc box.
- "All assets are content-addressed by sha256" — point at OPFS / cloud
  bucket.
- "Plugin trait stays stable from Phase 2 onward" — point at the
  Plugin trait box.

Format: one large landscape diagram. Use orthogonal/right-angle edges.
Bold module names, monospaced for types (Engine, TrackEngine, Y.Doc,
SharedArrayBuffer, postcard). Group layers with subtle background
shading. Include a short legend explaining arrow types (postMessage =
solid, SAB = dashed, BroadcastChannel = dotted, network = thick) and
the phase color coding.
```

---

## How to feed these to claude.design

1. Run **P0** first; save the output. Whatever palette / type / token
   names it returns, paste them as a preamble to later prompts — e.g.
   start the next prompt with `"Use the 8347 Studio visual system
   established earlier:"` followed by the tokens. This keeps later
   screens visually coherent.
2. Run prompts in any order after that. P1, P3, P4, P5 are the
   highest-value — the screens you'll iterate on most during
   development.
3. If a prompt is too dense, split it: ask for *just* the transport
   bar from P1, or *just* the channel strip from P4, etc.
4. When a mockup is good, save it (screenshot, link, or claude.design
   project) and reference it in the relevant phase plan as the visual
   spec for that phase's UI work.
