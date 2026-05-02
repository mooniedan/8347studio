# Phase 9 — Polish & ecosystem (forever-phase)

## Context

Phases 1–8 deliver a complete, collaborative, plugin-extensible DAW.
Phase 9 is **not a single phase** — it's a queue of independent polish
items that don't fit cleanly into earlier phases. Pull off the queue as
they become important. Each item is self-contained and can ship on its
own.

This file is a living backlog. Add items as friction is discovered;
remove them as they ship.

User-facing verb: **"refine the experience and grow the ecosystem."**

## Designs

- **P13 — Share / Export modal** (the *export-bundle* and *render-to-
  audio* tabs of this mockup; the share-live tab is Phase 8): drives
  the "Project export / import bundles" and "Stem export / bounce-in-
  place" backlog items
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Share+Export+Modal.html&via=share)

Other backlog items (controller-map presets, advanced automation
curves, plugin registry browser polish, etc.) extend earlier phases'
designs — re-use those mockups as starting points and capture new
prompts in [`design-prompts.md`](design-prompts.md) when an item gets
scheduled.

## Backlog

### Piano-roll editor polish (carry-over from Phase 2)

Phase-2 M4 shipped the headline verb (write notes, play, hear them on
the synth) with a click-to-toggle 1/16-step grid. The richer editing
listed in the M4 spec was deferred so M4 could close — pick up here:

- Drag-to-create variable-length notes (mouse-down at start, drag to
  end). Snap-grid aware.
- Drag note edges to resize.
- Drag note body to move (preserving length).
- Backspace / delete key removes the selected note(s).
- Snap-grid options: 1/4 / 1/8 / 1/16 / 1/32 / off, configurable per
  clip.
- Multi-select (shift-click, marquee-drag).
- Velocity lane below the grid (per-note velocity edit).
- Per-track clip-type switcher (StepSeq ↔ PianoRoll on the same
  track) — today each track is seeded with one or the other.

### Controller-map presets (carry-over from Phase 3)

- Per-device JSON presets stored separately from projects.
  `~/MIDI Maps/APC40.json` etc., importable / exportable.
- "Apply preset" UI in MIDI settings.
- Preset format documented for community contributions.

### Advanced automation curves (carry-over from Phase 4)

- Bezier handles between automation points.
- Exponential / S-curve / log presets.
- Curve-edit UI: drag tangent handles, curvature slider per segment.

### Graphical automation lane editor (carry-over from Phase 4 M4)

Phase-4 M4 shipped the engine evaluator + Y.Doc data path; today
points are added/removed via the `__bridge` backdoor only. Pick up
the visual layer here:

- Per-track lane below the piano-roll / step-seq view.
- Click-drag to add a point; drag points to move; right-click to
  change curve type or delete.
- "Pause + edit knob → create automation point" Live-style flow.
- Param picker ("automate which parameter?") with a tree by
  instrument / insert slot / send.

### Audio region editor polish (carry-over from Phase 5 M3)

Phase-5 M3 ships a minimal Audio track view — region cards with hash
+ filename + tick position. The richer editing the M3 spec lists
rides here:

- Drag region body to move; drag edges to trim; Alt-drag for slip-
  edit.
- Fade-in / fade-out handles on region corners.
- Inline waveform thumbnail per region (precomputed at import time,
  cached by hash).
- Multi-select + bulk move / delete.

### Warp / time-stretch UI + project-tempo re-stretch (carry-over from Phase 5 M4)

Phase-5 M4 shipped the engine OLA time-stretch (warp.rs) with cargo
correctness tests; the JS-side wiring stays for polish:

- Per-region `Follow tempo` toggle + `Original BPM` hint in the
  AudioTrackView.
- engine-bridge resolves region.warpFollowTempo + originalBpm into a
  pre-stretched PCM keyed by (hash, ratio); registers the stretched
  result as its own asset id.
- Re-stretch on project-tempo change (rebuilds affected assets).
- Higher-quality stretch (WSOLA with similarity matching, or phase
  vocoder) replaces the naive OLA when transient quality matters.

### Container branch editor (carry-over from Phase 4 M5)

Phase-4 M5 shipped the Container plugin engine path with a 2-branch
default and `__bridge` helpers for sub-insert wiring. The visual
editor is open work:

- Sub-panel inside an insert slot when the slot is a Container.
- Per-branch insert chain editor (recursive — same as the top-level
  InsertSlots component, just nested).
- Add / remove branches up to MAX_BRANCHES (= 8 in the engine).
- Per-branch gain / pan visible at a glance.

### Project export / import bundles (carry-over)

- Export = zip of `{ project.yjs, assets/<sha>.bin, ... }` with a
  manifest.
- Import = read zip, hydrate Y.Doc, dump assets into OPFS.
- Useful for offline backup, single-file sharing, cross-instance
  migration.

### Plugin registry browser UX

- Curated registry list (multiple registries, user-addable).
- Categories, search, filtering by kind.
- Plugin "card" with screenshots, version, license, install button.

### Performance pass

- Profile worst-case projects (32 tracks × 16-voice synths × FX
  chains).
- Audio-thread allocation audit: zero allocations after init.
- WASM size + load-time optimizations.
- UI frame-time profiling for piano-roll with 1000+ notes.

### Higher-quality time-stretch

- Replace WSOLA with phase-vocoder or élastique-class algorithm.
- Independent pitch-shift control.

### Audio comping / takes

- Take folders on Audio tracks (multiple recorded takes layered, click
  to choose which take is active per region).
- "Loop record" mode that captures takes across loop iterations.

### Stem export / bounce-in-place

- Render selected tracks (or master) to a WAV/FLAC file.
- Offline render mode (faster than realtime via the same engine in a
  Web Worker).
- "Freeze track" → render to audio clip in place to save CPU.

### Plugin presets / patch sharing

- Plugin-side preset save/load (JSON of param values).
- Shareable preset URLs / files.
- Per-plugin preset browser UI.

### Modulation matrix / LFO

- First-party `Modulator` plugin: LFO, random, envelope-follower.
- Modulation routing: "this LFO modulates that filter cutoff" — drag
  from modulator to any param.
- Could be implemented as a special automation source in the existing
  automation system.

### Multi-arm tracks

- Currently one armed track; lift restriction to allow multiple.
- Per-track input filter (channel, note range).

### Persisting popup layouts

- Phase 6 popups don't restore on reload. Save layout (which panels
  open, where) per project or per machine.

### Account system / persistent identity

- Sign-in (passkey or OAuth).
- Persistent user color/name across rooms.
- Per-room permissions (owner, editor, viewer).

### Mobile / touch UX

- Touch-friendly mixer + transport.
- Phone-as-controller mode (acts as PIP transport over LAN).

### Accessibility pass

- Keyboard navigation through all panels.
- Screen reader labels on knobs / sliders.
- High-contrast theme.

### CI & test harness

- Audio-snapshot test framework: render-to-PCM + sha256 baselines for
  every milestone-flagged scenario, run in CI.
- Performance regression tests: render-time budget per scenario.
- Visual regression tests for major UI components.

### Documentation site

- Public docs: user guide, plugin SDK reference, architecture
  overview.
- Could replace / augment internal `dream.md` for external consumers.

---

## How to add to this list

If you discover friction during phase 1–8 work that would be a real
distraction to fix in-phase, add it here with a one-line description
and ship the headline phase first. Items mature into proper plan files
under `.claude/plans/phase-9-<topic>.md` once they get scheduled.
