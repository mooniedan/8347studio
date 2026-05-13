# Overview

> _"Beat in L33T" (8 = B, 3 = E, 4 = A, 7 = T)_

**8347 Studio** is a Picture-in-Picture-friendly Digital Audio
Workstation that runs entirely in your browser.

## Architecture in one paragraph

Projects sync locally to **IndexedDB** through a Yjs CRDT — the
Y.Doc is the canonical source of truth for every track, clip, knob
position and plugin slot. Audio runs on the **Web Audio worklet
thread** through a **Rust engine compiled to WebAssembly**; the JS
side only sends snapshots and never blocks the audio callback.
Plugins are first-party today but the **WASM SDK is open** — any
manifest URL can be installed at runtime, integrity-verified, and
sandboxed inside the worklet.

## Why a browser DAW?

- **Zero install** — open the tab and start.
- **Multi-window native** — the Document Picture-in-Picture API
  lets the transport float above any other window.
- **CRDT-first** — every edit is mergeable, so Phase 9 collab is
  a routing question, not a data-model question.
- **Open plugin surface** — `manifest.json` + `.wasm` + SHA-256
  integrity, hosted anywhere over HTTPS.

## Where to go next

- [Quick start](#page:quick-start) — load the demo song and press play.
- [Transport bar](#page:transport) — every control on the top bar.
- [Plugins](#page:plugins) — install third-party WASM plugins.
- [Troubleshooting](#page:troubleshooting) — if something's stuck.
