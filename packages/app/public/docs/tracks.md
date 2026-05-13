# Tracks

Tracks live in the **left rail**. Each row shows the track's color
stripe (left edge, 4 px), its name, and an **Arm** pill (A).

## Adding a track

Use the **+ buttons** in the top bar:

| Button | What it makes |
|---|---|
| **+ Synth** | MIDI track + first-party Subtractive synth + empty piano-roll clip |
| **+ Drums** | MIDI track + the Drumkit plugin + empty piano-roll clip (the editor below switches to drum-row mode) |
| **+ Bus** | Audio bus track — destination for sends |
| **+ Audio** | Audio track that holds recorded/imported regions |
| **+ Plugin** | Open the plugin picker — installs a third-party WASM plugin and offers to attach it as an insert on the selected track |

## Track kinds

- **MIDI** — note data fed to an instrument plugin. Editor is the
  piano-roll (or drum-row view for drumkit tracks).
- **Audio** — recorded or imported audio regions. Editor is the
  region view (waveform polish pending; see Phase 10).
- **Bus** — audio destination for sends. No clips of its own; just
  insert FX and a fader.
- **Master** — always present, always last; receives every track's
  post-fader output.

## Selecting & arming

- **Click** a row → selects the track. The main canvas swaps to its
  editor; the inspector reflects its properties.
- **Click the A pill** → arms it. Hardware MIDI / audio input routes
  to the armed track. Only one track can be armed at a time.
- The selected track is _not_ necessarily the armed track. This is
  intentional — you can browse another track while still recording
  into the armed one.

## Reordering & deleting

- Drag a row to reorder (mixer strips reorder to match).
- Delete with the **×** in the row's hover overlay; the engine
  releases the track and any plugin handles tear down.

> _Track-row context menus, multi-select and group operations are
> in the Phase 10 polish queue._
