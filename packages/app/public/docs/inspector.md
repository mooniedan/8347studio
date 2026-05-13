# Track inspector

The **right inspector pane** reflects the selected track.

## Fields

- **Name** — editable in place. Press **Enter** or blur to commit,
  **Esc** to cancel.
- **Color** — click any of the 8 palette swatches. The stripe
  updates everywhere (rail, mixer strip, canvas head, clip borders,
  selection rings).
- **Kind** — read-only: MIDI / Audio / Bus.
- **Plugin** — the instrument bound to this track (synth / drumkit /
  third-party id). Click to focus the plugin panel.
- **Inserts** — count of insert FX on the chain. Click to scroll
  the plugin panel to the insert list.
- **Sends** — count of bus sends. Click to scroll to the send list.

## Show / hide

Press **Cmd / Ctrl + \\** to collapse the inspector. The collapsed
state persists across reload (per-machine, via LocalStorage).

## Why a separate pane?

- The main canvas stays focused on the editor (piano-roll, mixer,
  region view) while the inspector covers everything that doesn't
  belong in the editor's grid.
- It mirrors the Phase 7 design (`Arrangement View.html` mockup) —
  every property is one click away without crowding the canvas.

> _Clip-level inspector content (per-MIDI-clip name / length,
> per-audio-region fade times) is partly wired and partly pending
> in the Phase 10 polish queue._
