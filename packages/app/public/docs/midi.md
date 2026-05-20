# MIDI

8347 Studio uses the **WebMIDI** browser API for hardware input.

## Connecting a controller

1. Click **Enable MIDI** in the top bar — or open **Settings (⚙)**
   and click **Enable MIDI** there.
2. The browser prompts for WebMIDI permission. Grant it.
3. The MIDI chip appears with the device list. Pick:
   - **All devices** (default) — every connected controller routes
     into the armed track.
   - A specific device — only that one routes.

Hardware **NoteOn / NoteOff** routes to the **armed** track (the
filled red dot on the rail). If nothing's armed, MIDI follows the
**selected** track instead.

## Settings panel (Phase 10 M6)

The **⚙** button in the top bar opens a Settings modal with a
MIDI tab containing three sections:

- **Devices** — Web MIDI status (idle / requesting / granted /
  denied / unsupported), the active-input selector when granted,
  and an **Enable MIDI** button when permission is still pending.
- **Controller map** — the **MIDI Learn** toggle (mirror of the
  top-bar button) plus a per-binding list. Each row reads
  `CC<n> → <track name> · param <id>` with a ✕ to unbind.
- **Empty state** — a callout that points at MIDI Learn appears
  whenever the project has zero bindings.

Press **Esc** or click the backdrop to close.

## MIDI Learn

Bind a hardware CC to any plugin parameter:

1. Click the **Learn** button in the top bar.
2. Wiggle a hardware knob — the chip shows the captured CC number.
3. Click any plugin parameter in the panel — the CC is now bound.

Bindings live in the Y.Doc, so they **persist with the project**
and survive reloads.

To **unbind**, click the **CC₇₄ ✕** chip next to the bound
parameter.

## The demo song already has one bound

> The demo song ships with **CC#74 → Lead filter cutoff** already
> bound, so any controller with a standard "filter cutoff" CC
> opens the lead immediately.

## Browser support

WebMIDI is supported on Chromium-based browsers. Firefox shipped
it in 2024. Safari is partial; if `navigator.requestMIDIAccess` is
missing, the **Enable MIDI** button is hidden.
