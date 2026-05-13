# Plugins

8347 Studio ships with a small first-party set and a fully open
WASM SDK for third-party plugins.

## Built-in instruments

- **Subtractive synth** — 2 oscillators (sine / saw / square),
  state-variable filter (LP / HP / BP), amp envelope (ADSR),
  filter envelope (ADSR), 1–128 voice polyphony.
- **Drumkit** — 5-voice TR-style drum machine. Per-voice level /
  tune / decay + master gain.

## Built-in effects

- **EQ** — 4-band parametric.
- **Compressor** — feedforward peak.
- **Reverb** — Schroeder-style FDN.
- **Delay** — feedback + tone filter.
- **Container** — parallel-routing wrapper that holds up to 8
  sub-chains.

All implement the same Plugin trait the public SDK exposes — no
internal vs external split.

## Third-party plugins

Click **+ Plugin** to open the picker:

### Browse tab

Fetches a curated registry (the example registry ships with the
Bitcrusher + Gain plugins). Each card has an **Install** button;
once installed it switches to **✓ Installed**.

At the bottom, an **Install from URL** form accepts any manifest
URL you paste.

### Installed tab

Every installed plugin with **Add to {selected track}** buttons.
A red **FAILED** badge marks plugins that couldn't load on the last
boot (404, integrity drift, manifest invalid). They stay in the
list so the cause is visible, but the Add button is disabled.

## How installation works

1. Fetch the manifest JSON.
2. Validate the schema (required fields, semver, integrity-hash
   format, parameter shapes).
3. Fetch the linked `.wasm` and verify its SHA-256 against the
   manifest's `wasmIntegrity` (Subresource-Integrity style).
4. Instantiate the WASM inside the audio worklet and assign a
   handle.
5. Persist the manifest to `meta.installedPlugins` on the Y.Doc.
   On the next reload the boot path re-fetches + re-registers all
   stored plugins. **Insert slots reference the plugin by stable
   manifest id**, so a fresh handle is bound transparently.

## Sandboxing

Plugins get an audio I/O contract only. They cannot:

- Touch the DOM.
- Make network requests.
- Read the filesystem.
- Allocate on the audio thread (the Rust runtime enforces
  pre-allocated scratch buffers per block).

If a plugin needs UI today, the host renders it from the manifest's
parameter list. Custom UI surfaces are tracked in a later phase.
