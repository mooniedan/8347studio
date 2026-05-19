# Recording

Two record paths exist today — MIDI and live audio.

## Live MIDI

1. **Arm** a MIDI track (click its **A** pill in the rail).
2. Hit **Record** in the top bar — the dot pulses red.
3. Play your MIDI controller. The engine timestamps every NoteOn /
   NoteOff against the playhead.
4. On **Stop**, the captured notes commit into the armed track's
   piano-roll clip.

The clip's `lengthTicks` extends to cover any note recorded past
its old end.

## Live audio

1. **Arm** an Audio track.
2. Hit **Record**.
3. `getUserMedia` captures from the default input device into the
   **OPFS asset store** (content-addressed, so identical audio
   dedupes automatically).
4. On **Stop**, the recorded region drops onto the track at tick 0,
   referencing the OPFS asset by SHA.

### State visuals (Phase 10 M5)

- **Armed-not-recording** — armed track row gets a warm pulsing
  glow; the Audio strip shows an **ARMED** pill so the next take
  destination is obvious at a glance.
- **Recording** — the section gains a red ring, the dot in the
  Record button pulses, and the header switches to
  **● REC from \<device\>** (the device label from the live
  `MediaStreamTrack`, falling back to "Default input").
- **Take in progress** — a striped red placeholder block grows in
  real time inside the timeline at the end of any existing
  regions, so the user can see the take filling out before it
  commits as a real region on **Stop**.

## Quantization & overdub

- Recordings land at full PPQ resolution; no automatic quantize on
  capture. Run quantize from the clip editor (Phase 10 M2).
- Overdubbing into an existing clip preserves prior notes — new
  ones are appended. Replace-mode is on the polish queue.

## Things to know

- Recording into a track that has no instrument plugin is allowed
  but silent — you'll see the notes commit but hear nothing.
- The browser may suspend `AudioContext` until a user gesture. The
  **Record** button counts as the gesture.

> _Punch-in / punch-out, count-in, and comping across multiple
> takes are tracked in the Phase 10 polish queue (M5)._
