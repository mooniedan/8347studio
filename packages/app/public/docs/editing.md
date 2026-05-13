# Editing patterns

The **main canvas** shows the editor for the selected track. Three
kinds live there today.

## Step-sequencer clips

The legacy track type ships with a step-seq clip — a **16-step ×
N-pitch grid**. Click any cell to toggle a note on / off. The
**Bass** track in the demo song is a step-seq track.

- Velocity defaults to 100.
- Step length is 1/16 by default and not user-editable today.
- Cells light up as the playhead crosses them.

## Piano-roll clips

The default for instrument tracks created via **+ Synth**. Each row
is one MIDI pitch; each column is a 1/16 step.

- **Click** a cell → add a note (length = 1 step, velocity 100).
- **Click** again → remove it.
- The grid scales to match the clip's `lengthTicks`. A 4-bar clip
  shows **64 columns**.
- The playhead column lights up as the engine plays through it.
- Notes inside the playhead column show a **brighter accent**, so
  you can see exactly which note is firing right now.

> _Velocity drag, length drag, multi-select and free-position notes
> are tracked in Phase 10 M2 (P3 Piano Roll polish)._

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
