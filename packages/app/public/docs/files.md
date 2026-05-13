# Files & storage

Everything 8347 Studio knows about your work lives in your browser.
No server, no account, no upload — until Phase 9 collab ships.

## Where things live

| Surface | What it holds | When it's wiped |
|---|---|---|
| **IndexedDB** | One database per project, keyed by `docName`. Y.Doc updates + recorded audio refs. | Manual project delete, or browser-data clear. |
| **OPFS** | Content-addressed asset store (audio bytes). Hashes referenced from Y.Doc clip data. | Garbage collected when no project references the hash. |
| **LocalStorage** | Per-machine UI prefs only: inspector width, drawer height, layout collapsed state. | Browser-data clear. |

> Project state is **never** stored in LocalStorage — it would
> outgrow the 5 MB quota in minutes. LocalStorage is strictly UI
> preferences.

## Migrating between machines

Today: manual. Open `chrome://indexeddb-internals` (or equivalent)
to inspect; an **Export project bundle** action is on the Phase 10
M7 milestone.

When that ships, you'll be able to:

- **Export** a project as a `.zip` containing the Y.Doc snapshot
  plus referenced OPFS assets.
- **Import** the `.zip` back into IndexedDB on a different machine.
- **Render to audio** (WAV / FLAC / MP3) for non-DAW consumption.

## Privacy

- No telemetry. No analytics. No third-party scripts.
- WebMIDI permission is requested only on click.
- `getUserMedia` (audio recording) is requested only on first
  record.

The site is statically hosted; if you load it once, it works offline
(service worker caches the bundle).
