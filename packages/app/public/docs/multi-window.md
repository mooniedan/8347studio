# Multi-window workflow

8347 Studio is built for floating, multi-window use — that's where
the name's PiP origin shows up.

## Transport Picture-in-Picture

- Click **⌐ Transport** in the top bar.
- A 320 × 96 always-on-top window opens with the transport
  essentials: play/stop, BPM, project name, master meter.
- Useful when the main window isn't focused — code editors, video
  conferences, OBS, browsing.

The PiP window keeps a **BroadcastChannel** connection to the main
window, so play/stop and BPM stay in sync. Closing the PiP doesn't
stop playback.

**Browser support:** Chromium only. Firefox / Safari fall back to a
regular popup window with the same controls.

## Popout panels

Some panels can pop into their own window for multi-monitor work:

- **Mixer** — click the **⤴** icon at the top of the mixer drawer.
- _More panel popouts (PluginPanel, PianoRoll) are on the
  multi-window roadmap._

While the popup is open, the in-root version hides itself (no
duplicate controls). Closing the popup restores the in-root view.

## User guide PIP

This very window — the user guide — also opens in a Document PIP
window when you click the **?** button in the top bar. On browsers
without PIP, it opens as a regular tab at `?docs=1`.

## Cross-window awareness

The mixer popup, transport PIP, and main root all stay in sync
through a shared `BroadcastChannel`. Y.Doc updates merge across
windows, so editing in any window updates the others without
refresh.
