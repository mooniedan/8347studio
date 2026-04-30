# Phase 6 — Multi-window UX (PIP + popups)

## Context

After Phase 5 the DAW is a fully featured single-window app. This phase
adds the **multi-window workflow** that was decision Q10.D: a Document
Picture-in-Picture window for transport (always-on-top control) and
plain `window.open` popups for big panels (mixer, piano-roll, plugin
UIs) so multi-monitor users can lay out their workspace.

The architectural challenge: satellite windows are independent JS
contexts but share one Y.Doc and one audio engine. We need a clean
"render-only satellite" contract.

User-facing verb: **"control playback from a Picture-in-Picture window
while another app is foreground."**

## Designs

- **P8 — PIP transport window** (320×96, transport buttons + bar.beat
  + master meter + project name): the M3 PIP panel UI
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=PiP+Transport.html&via=share)

Note: the popped-out Mixer / Piano-roll / plugin panels (M4) reuse the
same designs as their in-root counterparts — see Phase 1's
[Mixer View](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Mixer+View.html&via=share)
and Phase 2's
[Piano Roll](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Piano+Roll.html&via=share)
/ [Subtractive Synth](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Subtractive+Synth.html&via=share).

## Milestones

### M1 — Satellite-window contract

- Define `SatelliteContext`: a small TS module satellite windows import.
  Provides:
  - A read-only Y.Doc replica (kept in sync via BroadcastChannel from
    root).
  - A `dispatch(command)` channel back to root (commands are the same
    intents as direct UI in root: `SetParam`, `Transport.Play`, ...).
  - `awareness` (cursor, transport position) shared.
- Root window is the *only* place the audio engine, MIDI, OPFS, and
  network sync run. Satellites are pure view + intent.
- **Test:** unit-test a satellite stub — receives Y.Doc updates, sends
  commands, root processes them.

### M2 — BroadcastChannel transport for Y.Doc

- Use Yjs's update format: root broadcasts `Y.Doc` updates on every
  local change; satellites apply them to their replicas.
- Satellites broadcast intents (commands) on a separate channel; root
  applies them to its Y.Doc (which then re-broadcasts the update —
  benign loop, idempotent).
- Initial sync: on satellite open, root sends a full state snapshot
  (`Y.encodeStateAsUpdate`).
- **Test:** Playwright with two pages on same origin acting as
  root + satellite — change made in satellite reflects in root within
  100ms; vice versa.

### M3 — Document PIP transport panel

- "Open Transport in PIP" button. Uses `documentPictureInPicture.requestWindow`.
- PIP renders: Play / Stop / Record buttons, BPM display, master meter,
  current-position display, project name, Loop toggle.
- Closing the PIP window does NOT stop playback; just collapses the
  panel back into the root UI.
- Re-opening reuses the same satellite context module.
- **Test:** Playwright (Chrome only) — click "Open Transport in PIP" →
  PIP window opens → click Play in PIP → root engine starts → close
  PIP → playback continues.

### M4 — Popup windows for big panels

- "Pop out" button on Mixer, PianoRoll, plugin panels → `window.open`
  same-origin URL with a query param indicating which panel to render.
- Popup uses the same Svelte build but boots into a "satellite-only"
  app shell (no engine, no MIDI bootstrapping, no asset import).
- Popups can be torn off and back: closing returns the panel to its
  in-root spot.
- Multiple popups allowed (multi-monitor).
- **Test:** Playwright — pop out the Mixer → adjust track 1 gain in the
  popup → root reflects → close popup → root still shows correct gain.

### M5 — Awareness for cross-window UX

- Awareness state per window: `{ kind: 'root'|'pip'|'popup', focused
  panel, current selection, current cursor (in piano-roll if open) }`.
- Transport position is the shared scrubbing state — moving the
  playhead in any window updates everywhere via awareness (not Y.Doc;
  position is ephemeral).
- This is also the seam Phase 8 will reuse for collaborator awareness.
- **Test:** Playwright — drag playhead in root → PIP shows updated
  position; drag playhead in PIP → root shows updated position.

## Verification (end of phase)

- **Manual:** With a project loaded, click "Open Transport in PIP" →
  PIP appears in corner → switch focus to a code editor → press Play in
  PIP → hear playback. Pop out the Mixer to a second monitor → adjust
  gains there → root reflects. Pop out the piano-roll → edit notes
  there → playback (controlled from PIP) reflects edits.
- **Automated:**
  - `pnpm playwright test phase-6` — cross-window sync, PIP open/close,
    popup open/close, command round-trip.
  - No new cargo tests (this phase is pure JS infrastructure).

## Critical files

- `packages/app/src/lib/satellite.ts` — context, BroadcastChannel,
  dispatch.
- `packages/app/src/lib/pip.ts` — Document PIP open/close.
- `packages/app/src/lib/awareness.ts` — cross-window awareness.
- `packages/app/src/satellite-shell.ts` — entry point used by popup
  windows + PIP.
- `packages/app/src/components/TransportBar.svelte` — gains "pop to
  PIP" button.
- `packages/app/src/components/Mixer.svelte`, `PianoRoll.svelte`, and
  plugin panels — gain "pop out" buttons.

## Out of scope

- Non-Chromium browser support (Document PIP is Chromium-only at
  present — Firefox/Safari users get the popup-only path).
- PIP-rendering plugin UIs from third-party plugins → Phase 7 is when
  third-party UIs exist; cross-window rendering of them can be added
  after.
- Persisting popup layouts across reloads → Phase 9.
