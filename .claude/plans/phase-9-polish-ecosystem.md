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

## Backlog

### Controller-map presets (carry-over from Phase 3)

- Per-device JSON presets stored separately from projects.
  `~/MIDI Maps/APC40.json` etc., importable / exportable.
- "Apply preset" UI in MIDI settings.
- Preset format documented for community contributions.

### Advanced automation curves (carry-over from Phase 4)

- Bezier handles between automation points.
- Exponential / S-curve / log presets.
- Curve-edit UI: drag tangent handles, curvature slider per segment.

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
