# Phase 5 — Audio clips & live recording

## Context

Until Phase 5 the DAW is MIDI-only. This phase introduces the **Audio
track type**, **audio clips with optional warp-to-tempo**, **OPFS-based
content-addressed asset storage** (the local cache half of decision Q11),
and **live audio recording** via `getUserMedia`.

User-facing verb: **"drag in a sample, record live audio over a beat."**

## Designs

- **P6 — Audio clip / waveform region** (region with embedded
  waveform thumb, fade overlays, inline editor in inspector): the M3
  region UI and M4 warp toggles
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Audio+Clip+View.html&via=share)
- **P11 — Recording / armed-track states** (also covers audio-track
  recording — the visuals are the same as Phase 3's MIDI version
  applied to an Audio track): the M5 recording UI
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Live+Recording+States.html&via=share)

## Milestones

### M1 — Audio track type & engine path

- Track kind `Audio` first-class. Audio tracks have no instrument slot;
  instead they have a list of `AudioRegion` clips.
- AudioRegion schema: `{ kind: "AudioRegion", trackId, startTick,
  lengthTicks, assetHash, sampleStart, sampleEnd, warpMode:
  "Natural"|"FollowTempo", gain, fadeIn, fadeOut }`.
- Engine: per audio block, walks active regions on each Audio track,
  reads the corresponding sample slice from the asset cache, applies
  fades + gain, mixes into track signal (still passes through inserts).
- Sample reads use a pre-warmed in-memory cache (LRU bytes budget) +
  OPFS-backed lazy loader.
- **Test:** cargo with a synthetic asset cache — render a 2s region of
  a known sine asset starting at tick T, assert output is a sine of
  expected freq, correctly placed.

### M2 — OPFS content-addressed asset store

- `packages/app/src/lib/asset-store.ts`:
  - `putBytes(bytes) → sha256` — hash, write `<hash>.bin` to OPFS,
    return hash; idempotent.
  - `get(hash) → Stream<Uint8Array>` — open the OPFS file for streaming
    reads.
  - `decode(hash) → Promise<{channels, sampleRate, frames, pcm}>` —
    decode (WAV / FLAC / MP3 / OGG) via `decodeAudioData`, cache the
    decoded result by hash.
- Y.Doc `assets: Y.Map<sha256, { channels, sampleRate, frames, format,
  origUrl?, sourceFilename? }>` — metadata only, never PCM.
- Engine receives PCM via the structural rebuild path (postMessage):
  on first reference of a hash, host posts the decoded frames; engine
  caches them.
- **Test:** Playwright — drop a WAV file → asset appears in OPFS at
  expected path → reload → asset is still there.

### M3 — Drag-drop sample import + region UI

- Drop file on an Audio track → import (hash, store, decode) → create a
  region at drop location, full sample length.
- Region UI: waveform thumbnail (rendered on import, cached), drag to
  move, drag edges to trim, hold Alt to slip-edit.
- Fade in/out handles on region corners.
- **Test:** Playwright — drop WAV → region rendered at correct position
  with waveform thumbnail → drag to new tick → playback hits at new
  tick.

### M4 — Warp / time-stretch (basic)

- Region `warpMode: FollowTempo` re-anchors the region to ticks instead
  of samples — when project tempo changes, the region's audible length
  in seconds changes.
- Implementation: WSOLA or simple phase-vocoder-lite for first cut;
  quality is "good enough for a v1," not ideal.
- UI: per-region toggle "Follow tempo" + "BPM hint" (the tempo the
  asset was originally recorded at, used to compute stretch ratio).
- **Test:** cargo — render a region at 120 BPM (warp on) at original
  120 BPM tempo → output ≈ original; render same region at 100 BPM
  project tempo → output is 1.2× longer with comparable pitch
  (no octave drop).

### M5 — Audio recording (getUserMedia)

- Audio track gains an "Input" picker: choose a `getUserMedia` audio
  source.
- "Arm" + Record (consistent with Phase 3 MIDI record):
  - On Record start: open a write stream to `<recording-id>.bin` in
    OPFS, capture incoming PCM at the project sample rate (resampling
    if needed).
  - On Stop: close stream, hash the file, register the hash in `assets`,
    create an AudioRegion at the recording start tick.
- Pre-roll / monitoring (input through-put while armed) — optional
  toggle, off by default to dodge feedback footguns.
- **Test:** Playwright with mocked `getUserMedia` stream feeding known
  PCM → record 2s → region appears with sha256 matching input;
  playback regenerates the same audio.

## Verification (end of phase)

- **Manual:** Drop a drum loop WAV → it sits at bar 1 at its natural
  tempo → toggle "Follow tempo" → it stretches to project BPM. Plug in
  a USB mic → arm an Audio track → press Record → speak/sing while a
  beat plays from a separate MIDI track → press Stop → play back →
  hear the recording over the beat. Reload the page → both the imported
  loop and the recording are restored from OPFS.
- **Automated:**
  - `cargo test -p audio-engine` — region scheduling, fade math, warp
    ratio.
  - `pnpm playwright test phase-5` — drag-import, recording flow with
    mocked stream, OPFS persistence after reload.
  - `cargo test offline_render audio_clip_baseline` — render an audio-
    clip-on-loop project, sha256 baseline.

## Critical files

- `crates/audio-engine/src/track_audio.rs`,
  `audio_region.rs`, `warp.rs`, `asset_cache.rs`.
- `packages/app/src/lib/asset-store.ts`,
  `audio-decoder.ts`, `audio-recorder.ts`.
- `packages/app/src/components/AudioTrack.svelte`,
  `AudioRegion.svelte`, `WaveformThumb.svelte`.

## Out of scope

- High-quality time-stretch (élastique-class) → Phase 9.
- Pitch-shift independent of stretch → Phase 9.
- Audio comping / take folders → Phase 9.
- Cloud asset upload (the *bucket* half of Q11.C) → Phase 8 (collab
  needs it; single-user doesn't).
- Stem export / bounce-in-place → Phase 9.
