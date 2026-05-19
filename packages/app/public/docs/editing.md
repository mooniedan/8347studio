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

### Selection + multi-delete

- **Shift+click** a note → toggle it in/out of the selection. A
  selected note carries a cyan outline.
- **Shift+drag** across the grid → draw a selection rectangle.
  Every note that overlaps the rect (in both pitch and tick range)
  joins the selection on release.
- **Delete** or **Backspace** → remove every selected note in one
  Y.Doc transaction.
- Selection is per-clip view state — it doesn't sync over collab,
  so each user picks their own working set.

### Velocity lane

Below the piano-roll grid sits a **per-note velocity lane** — one
vertical bar per note at its `startTick` column. Bar height encodes
velocity in the range **30..127** (default 100). Drag a bar up or
down to set that note's velocity live; the change persists into the
project and the engine plays the next pass at the new level. Multi-
step notes show their bar at the start column only — the rest of
the span follows automatically.

> _A right-pane note inspector is tracked in a later slice of
> Phase 10._

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

## Automation lanes

Every track with automation gets a stack of mini-editors below the
main editor (piano-roll / step-sequencer / audio timeline). Each
lane is one **target parameter** — instrument or insert — drawn as
an SVG row with a polyline through the existing points.

- **Click empty area** → add a point at the snapped step + clicked
  value. The value is taken from the cursor's y-position mapped
  through the lane's auto-scaled range.
- **Drag a point** → move it. The point's neighbours stay anchored;
  on release the array re-sorts so the engine's playback evaluator
  always sees points in tick order.
- **Shift-click a point** → remove it. When the last point goes,
  the whole lane is GC'd from the Y.Doc.
- The lane's y-axis **auto-scales** to the observed min/max of its
  own points — a 0..1 normalised param fills the same vertical
  space as a wide-range field like a filter cutoff (0..20k).
- Each lane writes through the Phase 4 M4 engine path that already
  drives the demo song's filter sweep; collab peers see point
  edits in real-time.

## Audio region view

Audio tracks now render as a **horizontal timeline**. Each region
sits at `startTick * PX_PER_TICK` and stretches across
`lengthTicks * PX_PER_TICK` pixels — the same pixels-per-step the
piano-roll uses, so an audio region lined up with a piano-roll clip
bars match column-for-column.

- **Waveform thumbnail.** Each region paints a downsampled peak
  series (one column per pixel) into a `<canvas>`. Decoding + peak
  extraction is cached per asset hash, so duplicating a region or
  scrubbing the track list doesn't re-decode the file.
- **Fade-in / fade-out overlays.** If a region's `fadeInSamples` or
  `fadeOutSamples` is non-zero, a dark triangular mask covers the
  faded portion of the waveform on the leading / trailing edge.
  The mask width is proportional to the fade duration as a
  fraction of the region length. Editable from the inspector panel
  (later M3 slice); the ★ Demo Song's Riser ships with a 0.25 s
  fade-in + 0.5 s fade-out so the look is visible out of the box.
- **Drag the body** of a region → move it along the timeline.
  Updates `startTick` (and `startSample` by the same ratio); the
  drag snaps to one step (1/16) so regions line up with the grid.
- **Drag the left edge** (a 6 px grip strip) → trim from the start.
  Increases `startTick` + `assetOffsetSamples` and shrinks
  `lengthTicks` + `lengthSamples` together so the trailing edge of
  the audio stays glued to the same frame.
- **Drag the right edge** → trim the end. Adjusts `lengthTicks` +
  `lengthSamples` only; minimum length is one step.
- All drags commit a single Y.Doc transaction on release, so collab
  peers see one consistent update per gesture.
- **Click** a region (no drag) → opens an inline inspector panel
  beneath the timeline with editable controls:
  - **Gain** slider (0..2, unity = 1.0).
  - **Fade in / Fade out** in milliseconds (writes the sample-domain
    fields via the asset's sample rate).
  - Read-out of `startTick`, `lengthTicks`, and `assetOffsetSamples`.
- Selected region carries a cyan outline that mirrors the inspector
  panel's open state. The panel's **×** button closes both.
- Reverse, loop, follow-tempo, original-BPM, sample-range sliders,
  and warp-algo are slated for a later slice (need engine work).
