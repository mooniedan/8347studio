# Transport bar

The top bar holds the global transport. Read left-to-right:

## Controls

- **Project menu** — switch / rename / archive projects, plus
  ★ Demo Song. See [Projects](#page:projects).
- **Play / Stop** — green when stopped, accent-red when playing.
  Stop returns the playhead to bar 1 tick 0.
- **Loop toggle + bar range** — when ticked, playback wraps at the
  loop end. Bars are 1-indexed.
- **BPM** — drag the readout vertically for ±1 BPM per pixel.
  - Hold **Shift** while dragging for 0.1 BPM precision.
  - The mouse wheel works too.
  - Double-click to type a value directly.
- **Tick** — current playhead position in ticks. The PPQ resolution
  is **960** (i.e. 960 ticks = one quarter-note).
- **Master meter** — stereo peak + RMS with a 1.5-second peak-hold.
  Green → amber → red as the signal approaches clip.

## On the right side

- **MIDI chip** — appears after you click **Enable MIDI**. See
  [MIDI](#page:midi).
- **Record dot** — pulses while armed and recording. See
  [Recording](#page:recording).
- **Collaborator avatars** — placeholder until Phase 9 ships
  live collab; currently empty.
- **⌐ Transport** — pop the transport out into a Picture-in-Picture
  window. See [Multi-window workflow](#page:multi-window).
- **? button** — opens this user guide.

## What changes while playing

- The Play button flips to accent-red.
- The tick readout advances.
- The master meter starts moving.
- Within the current editor (Sequencer or Piano-roll), the
  **playhead column** lights up so you can see exactly where you
  are in the bar.
