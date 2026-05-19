# Quick start

The fastest way to hear 8347 Studio in action is to load the demo
song.

## Three clicks to sound

1. **Open the app.** The Projects menu (top-left, just right of the
   wordmark) shows your projects. The default starter project carries
   one empty MIDI track.
2. **Click ★ Demo Song.** A feature-tour project loads with a Lead
   synth, a step-sequencer Bass, a Reverb bus, and a Drumkit track
   with a pre-painted pattern.
3. **Hit Play** (the green button on the transport bar). The demo
   plays end-to-end — chord progression, sample-rate-crushed bass,
   drum groove, reverb tail, automation sweep on the lead filter.

## The demo song is ephemeral

> Every reload starts it fresh. Every click on ★ Demo Song re-seeds
> the canonical version. The moment you edit anything, a banner
> offers to save your changes as a new persistent project.

## What the demo proves works today

| Feature | Where to hear it |
|---|---|
| Polyphonic subtractive synth | Lead track chord stabs |
| Step-sequenced bass | Bass track on every beat |
| **Per-step velocity** (Phase 10 M1) | Bass downbeats accented vs. ghosted off-beats |
| Sample-rate crusher (third-party WASM plugin) | Bass insert FX, mix sweep automation |
| Drumkit (kick / snare / hat / clap / open-hat) | Drum track groove |
| Drum-row piano-roll editor | Select the Drum track; rows show GM-pitch labels |
| Sends + bus track | Lead + Bass → Reverb Bus |
| Parameter automation | Lead filter cutoff sweep + bitcrusher mix sweep |
| MIDI Learn binding | CC#74 → Lead filter cutoff |
| Transport loop region (4 bars) | Playback wraps every 4 bars |
| Multi-window transport | Click ⌐ Transport in the top bar |

If a new feature ships in the codebase and the demo doesn't exercise
it, the demo is wrong, not the feature.

## Features the demo can't cover

A few things have to be tried manually because they live outside the
single-Y.Doc seed:

- **Audio import & recording** ([Recording](#page:recording)) — bring
  your own sample / mic.
- **Live collab** ([Multi-window](#page:multi-window)) — needs a
  second browser or device. Click ⤴ Share.
- **Plugin installation flow** ([Plugins](#page:plugins)) — the demo
  pre-installs the bitcrusher, but the picker UI is best explored
  on a fresh project.
