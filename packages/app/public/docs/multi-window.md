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

## Sharing a session (Phase 9 M5)

Click the **⤴ Share** button in the top bar. The first click:

- Generates a short room id and connects to the configured sync
  server (`VITE_SYNC_URL`, default `ws://localhost:1234`).
- Updates the URL bar to `…?room=<id>` and copies the full link to
  the clipboard.
- The Share button text flips from `⤴ Share` to `⤴ connected`,
  and a small avatar with your display name appears next to it.

A second person opening the link in any browser joins the same
room and sees your project state. From then on, every edit either
of you makes flows through the sync server and merges on both ends.

Identity is per-machine — your display name + an ephemeral color
live in `localStorage`. They're sent over awareness so peers can
tell each other apart.

### Awareness affordances (Phase 9 M4)

Once a peer joins your room:

- A **peer avatar** appears next to your own in the top bar, with
  the peer's color and the first letter of their name.
- The **track row a peer has selected** shows a ghost ring + dot
  in their color, so you can see what they're working on at a
  glance.
- In the **piano-roll**, the cell a peer is hovering renders a
  ghost outline in their color — useful for guiding a friend's
  attention to a specific note.

Awareness is ephemeral — when a peer leaves the room their avatar
and ghost markers vanish.

### Testing collab locally

The simplest way to try collab on a single machine is two browsers
or two profiles open on `https://localhost:8347/?room=foo`.

For testing with a friend on the same Wi-Fi, run `pnpm dev:share`
from the repo root instead of the usual `pnpm dev`. It boots the
sync server + Vite on `0.0.0.0`, drops the dev cert (plain HTTP so
WebSocket isn't blocked by mixed-content), and prints the LAN URLs
to share. Visit `http://<your-laptop-ip>:8347/?room=<id>` on both
devices.

For testing over the internet, expose the printed URLs via Tailscale,
Cloudflare Tunnel, or `ngrok http`, then point each peer at the
tunnel host.

> Realtime audio / MIDI streaming between peers is **not** in
> scope; each peer renders audio locally from the shared project +
> tempo map. Phase 9 M3 adds shared transport state (play/stop in
> lockstep). For now only the project state syncs.
