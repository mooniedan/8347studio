# MIDI

8347 Studio uses the **WebMIDI** browser API for hardware input.

## Connecting a controller

1. Click **Enable MIDI** in the top bar.
2. The browser prompts for WebMIDI permission. Grant it.
3. The MIDI chip appears with the device list. Pick:
   - **All devices** (default) — every connected controller routes
     into the armed track.
   - A specific device — only that one routes.

Hardware **NoteOn / NoteOff** routes to the **armed** track (the
filled red dot on the rail). If nothing's armed, MIDI follows the
**selected** track instead.

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
