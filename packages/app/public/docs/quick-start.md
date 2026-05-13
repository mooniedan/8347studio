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
| Step-sequenced bass | Bass track on beats 1 & 3 |
| Sample-rate crusher (third-party WASM plugin) | Bass insert FX |
| Drumkit (kick/snare/hat/clap/open-hat) | Drumkit track groove |
| Sends + bus track | Lead + Bass → Reverb Bus |
| Parameter automation | Lead filter cutoff sweep |
| MIDI Learn binding | CC#74 → Lead filter cutoff |
| Multi-window transport | Click ⌐ Transport in the top bar |

If a new feature ships in the codebase and the demo doesn't exercise
it, the demo is wrong, not the feature.
