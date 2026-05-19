# Editing patterns

The **main canvas** shows the editor for the selected track. Three
kinds live there today.

## Step-sequencer clips

The legacy track type ships with a step-seq clip — a **16-step ×
N-pitch grid**. Click any cell to toggle a note on / off. The
**Bass** track in the demo song is a step-seq track.

- Step length is 1/16 by default and not user-editable today.
- Cells light up as the playhead crosses them.

### Velocity lane

Below the main grid sits a **velocity lane** — one vertical bar per
step. Drag a bar up or down to set that step's velocity (range
30–127, default 100). The bass groove in the Demo Song uses varied
velocities to accent the downbeats; you can hear the effect by
clicking **★ Demo Song** and listening to the Bass track.

### Pattern actions

- **Clear** — wipes every step in the visible track's clip.
- **Randomize** — drops a kick on every 4th step plus 0–6
  probabilistic off-beat hits at varied velocities. A starting
  point, not a finished groove.

## Piano-roll clips

The default for instrument tracks created via **+ Synth**. Each row
is one MIDI pitch; each column is a 1/16 step.

- **Click** a cell → add a 1-step note at velocity 100. **Click**
  it again → remove.
- **Drag** across a row → create a longer note spanning the dragged
  columns. The ghost overlay shows what you'll commit; release to
  add it.
- **Drag the body** of an existing note → move it. The ghost
  follows your cursor across both columns and pitch rows; length and
  velocity are preserved on release.
- **Drag the right edge** of a note (last ~25% of its rightmost
  cell, where the cursor sits over the grip) → resize. The start
  tick stays fixed; release sets the new length.
- Clicking any column inside a multi-step note (without dragging)
  removes the whole note.
- The grid scales to match the clip's `lengthTicks`. A 4-bar clip
  shows **64 columns**.
- The playhead column lights up as the engine plays through it.
- Notes inside the playhead column show a **brighter accent**, so
  you can see exactly which note is firing right now.

### Velocity lane

Below the piano-roll grid sits a **per-note velocity lane** — one
vertical bar per note at its `startTick` column. Bar height encodes
velocity in the range **30..127** (default 100). Drag a bar up or
down to set that note's velocity live; the change persists into the
project and the engine plays the next pass at the new level. Multi-
step notes show their bar at the start column only — the rest of
the span follows automatically.

> _Selection rectangle + multi-select and a right-pane note
> inspector are tracked in the next slices of Phase 10 M2._

## Drum-row view

Drumkit tracks render the piano-roll with **5 named rows** instead
of the C3..C5 melodic range:

| Row | MIDI | Plays |
|---|---|---|
| Open Hat | 46 | Long-decay high-passed noise |
| Closed Hat | 42 | Short noise; chokes Open Hat |
| Clap | 39 | Stuttered noise bursts |
| Snare | 38 | Body sine + noise |
| Kick | 36 | Sine + pitch envelope + click |

Closed-hat hits **choke** any sustained Open Hat — the classic TR
behaviour preserved in the engine.

## Audio region view

Audio tracks show their region as a horizontal block at its
`startTick`. Drag the block to move it. Region trimming, waveform
thumbnails and fade handles are in Phase 10 M3 polish.
