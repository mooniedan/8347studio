# Troubleshooting

If something's stuck, check these first.

## No sound on play

- **Master meter silent?** No track is producing audio. Confirm the
  selected track has notes in its clip and the master gain isn't 0.
- **Master meter moving but speakers silent?** Check the OS / browser
  volume. The Master fader is post-summing — if its meter shows
  movement, the engine is doing its job.
- **Browser audio context suspended.** Some browsers suspend audio
  until a user gesture. Clicking **Play** counts as the gesture; if
  you've programmatically called play, click anywhere in the window
  first.

## Plugin shows FAILED in the picker

The integrity hash didn't match (the WASM was edited after the
manifest was signed) or the WASM URL 404'd.

- Re-install from a fresh manifest URL.
- If you control the plugin, regenerate the integrity hash:
  `openssl dgst -sha256 -binary plugin.wasm | openssl base64 -A`
  → prepend `sha256-` to get the manifest's `wasmIntegrity` value.

## Demo Song banner won't go away

That's expected while the demo slot is active — the banner reminds
you edits are scratch.

- Click **Save as new project…** to fork into a persistent project.
- Click ★ Demo Song again to re-seed the canonical version.
- Switch to any other project from the Projects menu.

## Cmd / Ctrl shortcut not working

Check the focus is on the app, not in an input field. Some
shortcuts are window-level and should work anywhere; others (text
input ones) defer to the focused element first.

## Transport PIP button is disabled

The browser doesn't expose the Document Picture-in-Picture API.
Today: Chromium only. Firefox & Safari users get the popup-window
fallback automatically on click.

## MIDI controller not detected

- Did you click **Enable MIDI** _after_ plugging in?
- Check `chrome://settings/content/midiDevices`.
- On macOS, virtual MIDI buses (IAC) appear once you enable them in
  Audio MIDI Setup.

## Recording captures nothing

- Track armed? (Red dot lit on the row.)
- For audio: did the browser prompt for microphone access? Look for
  the `getUserMedia` icon in the address bar.

---

## Where to file issues

The project lives at
<https://github.com/mooniedan/8347studio>.

Open an issue if a feature isn't behaving as documented here — the
docs and the code should agree.
