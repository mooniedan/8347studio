# Phase 8 — Live collaboration

## Context

The architecture has been collab-ready since Phase 1 (Yjs project state,
content-addressed assets, awareness-friendly transport). This phase
**flips the switch**: stand up a sync server, wire awareness, push
assets to a cloud bucket, and ship the multi-user UX.

User-facing verb: **"make a beat with a friend in real time."**

Decision recap (from grill): collab depth is **B** — edit-time edits +
shared transport. No realtime audio or MIDI streaming between clients.
Audio is rendered locally per client from the shared project + tempo
map, kept in lockstep via clock-synced transport messages.

## Designs

- **P10 — Collaboration affordances** (avatars, remote cursors,
  selection rings, "following" indicator, awareness border on
  edited mixer strips): M3–M4 awareness UI and M5 join experience
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Collaboration+View.html&via=share)
- **P13 — Share / Export modal** (share-live tab with room URL and
  collaborator list): the M5 share dialog (the export-bundle and
  render-to-audio tabs in this same mockup are Phase 9 work)
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Share+Export+Modal.html&via=share)

## Milestones

### M1 — Sync server

- Self-hosted `y-websocket` (or compatible) server. New service:
  `services/sync-server/` (Node + ws or Rust + tokio-tungstenite).
- Endpoints: `wss://.../room/<roomId>` for project sync,
  `wss://.../awareness/<roomId>` for ephemeral awareness state (or
  multiplexed onto the same socket — y-websocket multiplexes natively).
- Auth: simple token-in-URL (room-secret). Real auth deferred.
- **Test:** integration test — two clients connect, edit, see each
  other's edits within RTT; one client disconnects, reconnects, catches
  up.

### M2 — Cloud asset bucket

- Add `AssetStorageRemote` interface alongside the OPFS local store
  from Phase 5.
- On record / import: compute hash, write to OPFS, enqueue background
  upload to the bucket (`PUT <bucket>/<hash>`).
- On project load: any referenced hash not present locally → fetch from
  bucket → cache in OPFS.
- Bucket = S3-compatible (S3 / R2 / minio for self-host). Configured by
  env var; if not configured, collab features are disabled.
- **Test:** Playwright with a test bucket — recording on client A
  uploads → client B can play the recording without ever recording it.

### M3 — Shared transport

- Awareness state gains: `transport: { state: "playing"|"stopped",
  startTick, startedAtClientTime, hostId }`.
- One client at a time is "transport host" (the one who pressed Play
  most recently). Others follow.
- Followers compute their local playback start time as
  `hostStartedAtClientTime + (clientNow - hostNow)`, accounting for
  clock skew via a small NTP-style ping protocol.
- Latency mismatches are visible as a sub-100ms drift between users'
  audio — accepted (decision Q2.B explicitly excluded sub-50ms
  guarantees).
- **Test:** Playwright with two clients — A presses Play → B hears
  audio start within ≤200ms of A; both clients render identical PCM
  given the same project + same starting tick.

### M4 — Awareness UI

- Cursor / selection awareness rendered in the relevant editor:
  - Piano-roll: ghost cursor with user color + name.
  - Mixer: highlight on the strip a user is editing.
  - Timeline: show ghost playhead per remote user (their *local*
    transport position, useful when they've scrubbed independently).
- Presence list in a sidebar with avatars + colors.
- **Test:** Playwright — A clicks a note in piano-roll → B sees A's
  cursor land on that note within 200ms.

### M5 — Sharing & joining a session

- "Share" button → generates a room URL (`https://app/?room=<id>`) +
  copies to clipboard.
- Joining the URL: prompt for display name, fetch project state, fetch
  any missing assets from bucket, render UI when ready.
- Late joins: get current Y.Doc state via initial WS sync; transport
  state from awareness.
- Leaving / closing: clean up awareness; project persists on server.
- **Test:** Playwright — A creates project, shares URL, B opens URL in
  fresh context → sees same project, can edit, edits sync back.

### M6 — Conflict ergonomics

- Yjs handles merge automatically, but UX needs to be sane:
  - Two users editing the same note: last-write-wins on each field
    (start, length, pitch, velocity); shouldn't normally collide.
  - Two users adding clips at the same tick: both clips coexist.
  - Two users moving the same clip: last-write-wins on position.
- Visual hint when a remote user is actively editing an object you've
  selected (your selection turns dimmed).
- **Test:** scripted concurrent edits in Playwright with two browser
  contexts — verify no data loss, deterministic merge.

## Verification (end of phase)

- **Manual:** Spin up sync server + minio asset bucket locally → open
  app on two browsers (or send the URL to a friend over a public
  deployment) → both edit → both press Play → both hear the same audio
  in lockstep → one records into a track → the other hears the
  recording on next play.
- **Automated:**
  - `pnpm playwright test phase-8` — two-context flows: shared edit,
    asset upload/fetch, transport sync within tolerance.
  - `services/sync-server/` integration tests — connection lifecycle,
    auth, multi-client.

## Critical files

- `services/sync-server/` — new service.
- `packages/app/src/lib/sync.ts` — y-websocket provider config.
- `packages/app/src/lib/asset-storage-remote.ts` — bucket client.
- `packages/app/src/lib/clock-sync.ts` — NTP-ish RTT measurement.
- `packages/app/src/lib/awareness.ts` — extended for collaborator state
  (already exists from Phase 6 for cross-window).
- `packages/app/src/components/PresenceList.svelte`, `ShareDialog.svelte`,
  `RemoteCursor.svelte`.

## Out of scope

- Account system / persistent user identity → Phase 9 if needed (a
  display-name + ephemeral color is fine for v1).
- Voice / video chat → use a separate tab / app.
- Realtime MIDI jam (Q2.C) → explicit stretch, not in this phase.
- Audio streaming jam (Q2.D) → explicit stretch.
- Permissions / access control beyond room-secret URL → later.
- Conflict-resolution UI for irreconcilable cases (rare with Yjs) →
  Phase 9.
