# 8347 Studio — user guide

> _"Beat in L33T" (8 = B, 3 = E, 4 = A, 7 = T)_

8347 Studio is a Picture-in-Picture-friendly Digital Audio Workstation
that runs entirely in your browser. Projects sync locally to
IndexedDB; audio runs on the Web Audio worklet thread through a Rust
engine compiled to WebAssembly. Plugins are first-party today but the
WASM SDK is open — anyone can publish a plugin URL and install it.

## Quick start

1. Open the app. The Projects menu (top-left, just right of the
   wordmark) shows your projects. The default starter project carries
   one empty MIDI track.
2. Click **★ Demo Song**. A feature-tour project loads with a Lead
   synth, a step-sequencer Bass, a Reverb bus, and a Drumkit track
   with a pre-painted pattern.
3. Hit **Play** (the green button on the transport bar) and the demo
   plays end-to-end — chord progression, sample-rate-crushed bass,
   drum groove, reverb tail, automation sweep on the lead filter.

> The demo song is _ephemeral_: every reload starts it fresh, every
> click on ★ Demo Song re-seeds the canonical version. The moment you
> edit anything, a banner offers to save your changes as a new
> persistent project.

## Transport

The top bar holds the global transport. Read left-to-right:

- **Project menu** — switch / rename / archive projects, plus
  ★ Demo Song.
- **Play / Stop** — green when stopped, accent-red when playing.
- **Loop toggle + bar range** — when ticked, playback wraps at the
  loop end. Bars are 1-indexed.
- **BPM** — drag the readout vertically for ±1 BPM per pixel.
  Hold **Shift** while dragging for 0.1 BPM precision. Wheel works
  too. Double-click to type.
- **Tick** — current playhead position in ticks (PPQ = 960).
- **Master meter** — stereo peak + RMS with a 1.5-second peak-hold.
  Green → amber → red as the signal approaches clip.

The transport panel can also live in a Picture-in-Picture window —
see _Multi-window workflow_ below.

## Tracks

Tracks live in the left rail. Add new ones from the top bar:

| Button | What it makes |
|---|---|
| **+ Synth** | MIDI track + first-party Subtractive synth + empty piano-roll clip |
| **+ Drums** | MIDI track + the Drumkit plugin + empty piano-roll clip (the editor below switches to drum-row mode) |
| **+ Bus** | Audio bus track — destination for sends |
| **+ Audio** | Audio track that holds recorded/imported regions (region editor still polish-pending; see _Audio_) |
| **+ Plugin** | Open the plugin picker — installs a third-party WASM plugin and offers to attach it as an insert on the selected track |

Each row shows the track's color stripe (left edge, 4 px), its name,
and an Arm pill. Click a row to select the track; the canvas swaps to
its editor.

### Track inspector

The right inspector pane reflects the selected track:

- **Name** — editable in place (Enter or blur to commit, Esc to
  cancel).
- **Color** — click any of the 8 palette swatches. The stripe updates
  everywhere (rail, mixer strip, canvas head).
- **Kind / Plugin / Inserts / Sends** — read-only summary so you can
  see at a glance what's loaded.

Press **Cmd/Ctrl + \\** to collapse the inspector. It persists across
reload.

## Editing patterns

### Step-sequencer clips

Tracks created with **+ Synth** ship with a piano-roll clip by
default. Tracks created the legacy way (built-in oscillator) get a
step-seq clip — a 16-step × N-pitch grid. Click any cell to toggle a
note on/off. The bass track in the demo is a step-seq track.

### Piano-roll clips

The default for instrument tracks. Each row is one MIDI pitch; each
column is a 1/16 step. Click a cell to add a note (length = 1 step,
velocity 100); click again to remove. The grid scales to match the
clip's `lengthTicks` — a 4-bar clip shows 64 columns.

The playhead column lights up as the engine plays through. Notes
inside the playhead's current column show a brighter accent (so you
can see _which_ note is firing).

### Drum-row view

Drumkit tracks render the piano-roll with 5 named rows instead of the
C3..C5 melodic range:

| Row | MIDI | Plays |
|---|---|---|
| Open Hat | 46 | Long-decay high-passed noise |
| Closed Hat | 42 | Short noise; chokes Open Hat |
| Clap | 39 | Stuttered noise bursts |
| Snare | 38 | Body sine + noise |
| Kick | 36 | Sine + pitch envelope + click |

Closed-hat hits choke any sustained Open Hat — the classic TR
behaviour.

## Mixer

The bottom drawer holds the mixer. Click the **▾/▴** chevron (or
press **Cmd/Ctrl + M**) to collapse / expand. Default state and
height persist per-machine.

Each channel strip has, top to bottom:

- **Color stripe + track name** — matches the rail / canvas head.
- **Insert FX slots** — up to 4 visible. Filled slots show the
  effect name; empty slots are dashed placeholders.
- **Sends** — sends to bus tracks. The demo's Lead + Bass send into
  the Reverb Bus.
- **Pan** — −1 (left) to +1 (right).
- **Fader** + **stereo meter** — peak + RMS with hold-line. Use
  the mouse wheel or drag to change.
- **S / M pills** — Solo isolates the track; Mute silences it.
- **dB readout** — current fader value in dB (mono font).

The Master strip on the right is wider and reserves a slot for a
master limiter.

## Plugins

### Built-in instruments

- **Subtractive synth** — 2 oscillators (sine / saw / square), state-
  variable filter (LP / HP / BP), amp envelope (ADSR), filter
  envelope (ADSR), 1–128 voice polyphony.
- **Drumkit** — 5-voice TR-style drum machine. Per-voice level / tune
  / decay + master gain.

### Built-in effects

EQ (4-band parametric), Compressor (feedforward peak), Reverb
(Schroeder-style FDN), Delay (with feedback + filtering),
Container (parallel-routing wrapper that holds up to 8 sub-chains).
All implement the same Plugin trait the public SDK exposes.

### Third-party plugins

Click **+ Plugin** to open the picker:

- **Browse tab** — fetches a curated registry (the example registry
  ships with the Bitcrusher + Gain plugins). Each card has an
  **Install** button; once installed it switches to **✓ Installed**.
  At the bottom, an **Install from URL** form accepts any manifest
  URL the user pastes.
- **Installed tab** — every installed plugin with **Add to {selected
  track}** buttons. A red **FAILED** badge marks plugins that
  couldn't load on the last boot (404, integrity drift, manifest
  invalid) — they stay in the list so the cause is visible but the
  Add button is disabled.

#### How installation works

1. Fetch the manifest JSON.
2. Validate the schema (required fields, semver, integrity-hash
   format, parameter shapes).
3. Fetch the linked `.wasm` and verify its SHA-256 against the
   manifest's `wasmIntegrity` (Subresource-Integrity style).
4. Instantiate the WASM inside the audio worklet and assign a
   handle.
5. Persist the manifest to `meta.installedPlugins` on the Y.Doc.
   On the next reload the boot path re-fetches + re-registers all
   stored plugins. Insert slots reference the plugin by stable
   manifest id, so a fresh handle is bound transparently.

Plugins are sandboxed: they get an audio I/O contract only. No DOM,
no network, no filesystem.

## Projects

The Projects menu manages multiple persistent projects:

- **+ New project…** — prompt for a name; opens a fresh project.
- **★ Demo Song** — opens the ephemeral demo. Edits are scratch-only
  until you click **Save as new project…**.
- **Switch** — clicking any project in the list tears down the
  current one and boots the chosen one.
- **Rename** — pencil icon next to the active project.
- **Archive / Restore** — soft-delete into a trash drawer; restore
  brings it back; **Empty trash** purges the IndexedDB store.

The demo song's edits never overwrite the canonical seed. When you
fork via Save-as, the new persistent project carries the demo's
state verbatim — including any installed plugins.

## MIDI

### Connecting a controller

- Click **Enable MIDI** in the top bar. The browser prompts for
  WebMIDI permission.
- Once granted, the MIDI chip shows the device list; pick **All
  devices** (default) or a specific one.
- Hardware NoteOn / NoteOff routes to the **Armed** track (the
  filled red dot on the rail). If nothing's armed, MIDI follows the
  selected track.

### MIDI Learn

- Click the **Learn** button in the top bar.
- Wiggle a hardware knob — the chip shows the captured CC number.
- Click any plugin parameter in the panel — the CC is now bound.
- Bindings live in the Y.Doc, so they persist with the project.

To unbind, click the **CC₇₄ ✕** chip next to the bound parameter.

> **The demo song** ships with **CC#74 → Lead filter cutoff** already
> bound, so any controller with a standard "filter cutoff" CC opens
> the lead immediately.

## Recording

### Live MIDI

- Arm a track (click its **A** pill in the rail).
- Hit **Record** in the top bar (the dot pulses red while armed).
- Play your MIDI controller — notes commit into the armed track's
  piano-roll clip on stop.

### Live audio

- Arm an Audio track and hit Record. `getUserMedia` captures from
  the default input device into the OPFS asset store; on stop the
  recorded region drops onto the track at tick 0.

## Multi-window workflow

### Picture-in-Picture transport

- Click **⌐ PIP** in the top bar.
- A 320 × 96 always-on-top window opens with the transport
  essentials (play/stop, BPM, project name, master meter).
- Useful when the main window isn't focused — code editors, video
  conferences, etc.

Chromium only. Firefox / Safari users get a regular popup-window
fallback.

### Popout panels

The mixer can pop into a separate window for multi-monitor work.
Click the **⤴** icon at the top of the mixer drawer. While the popup
is open, the in-root drawer hides itself (no duplicate controls).
Closing the popup restores the drawer.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Cmd/Ctrl + \\** | Toggle the right inspector |
| **Cmd/Ctrl + M** | Toggle the bottom mixer drawer |
| **Cmd/Ctrl + ,** | (planned) Open settings — currently click the cog |
| **Space** | (planned) Play / stop |

## File / data layout

- **IndexedDB** — one database per project, keyed by docName. Each
  database holds the project's Y.Doc updates + (where applicable)
  recorded audio.
- **OPFS** — content-addressed asset store for sample / recorded
  audio bytes. Hashes referenced from Y.Doc clip data.
- **LocalStorage** — per-machine UI prefs (inspector width, drawer
  height, layout collapsed state). Project state is _never_ stored
  here.

## Troubleshooting

- **No sound on play?** Check the master meter — if it's silent,
  no track is producing audio. Confirm the selected track has notes
  in its clip and the master gain isn't 0. Some browsers suspend
  audio until a user gesture; clicking Play counts as the gesture.
- **Plugin shows FAILED in the picker.** The integrity hash didn't
  match (the WASM was edited after the manifest was signed) or the
  WASM URL 404'd. Re-install from a fresh manifest URL.
- **Demo Song banner won't go away.** That's expected while the
  demo slot is active — the banner reminds you edits are scratch.
  Click **Save as new project…** to fork into a persistent project,
  or click ★ Demo Song again to re-seed.
- **Cmd/Ctrl shortcut not working.** Check the focus is on the app
  (not in an input field). Some shortcuts are window-level and
  should work anywhere; others (text input ones) defer to the
  focused element first.

---

**Where to file issues**

The project lives at <https://github.com/mooniedan/8347studio>.
Open an issue if a feature isn't behaving as documented here — the
docs and the code should agree.
