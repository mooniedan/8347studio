# Phase 7 — Public plugin SDK

## Context

By this phase the host has been exercising the Plugin trait for five
phases (synths in Phase 2, FX + container in Phase 4) and the trait is
proven. Phase 7 publishes the **public SDK**: third-party plugins
written as a WASM DSP module + JS UI bundle, loaded from a URL, sandbox-
isolated from the host.

User-facing verb: **"load a third-party plugin from a URL."**

## Designs

- **P9 — Plugin picker / installer** (Installed grid + Browse/Install-
  from-URL tab with registry cards, integrity checkmarks): the M4
  plugin loader UX and M6 registry browser
  · [view](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Add+Plugin+Picker.html&via=share)

Third-party plugin UIs render via the same web-component sandbox that
the host-rendered default UI ([Subtractive Synth from Phase 2](https://claude.ai/design/p/019dde9c-e274-7e0c-a252-40c2d84785ca?file=Subtractive+Synth.html&via=share))
established as the visual baseline.

## Milestones

### M1 — Plugin manifest format (finalized)

- JSON manifest schema:
  ```json
  {
    "id": "com.example.acme-reverb",
    "name": "Acme Reverb",
    "version": "1.0.0",
    "kind": "effect" | "instrument" | "container",
    "wasm": "https://cdn.example/acme-reverb-1.0.0.wasm",
    "wasmIntegrity": "sha256-...",
    "ui":   "https://cdn.example/acme-reverb-1.0.0-ui.js",
    "uiIntegrity": "sha256-...",
    "params": [{ "id":"mix", "name":"Mix", "min":0, "max":1,
                 "default":0.3, "curve":"linear" }, ...],
    "license": "MIT",
    "homepage": "...",
    "icon": "..."
  }
  ```
- All assets content-addressed; integrity hashes verified at load.
- **Test:** schema validator with positive + negative fixtures.

### M2 — WASM plugin runtime (in engine)

- Engine can host a third-party WASM plugin alongside static plugins.
  Both implement the same logical `Plugin` trait, but the WASM path
  goes through a thin dispatcher that calls exported functions.
- Required exports:
  `init(sample_rate, max_block_size) → handle`,
  `set_param(handle, id, value)`,
  `handle_event(handle, kind, p1, p2)`,
  `process(handle, in_ptr, out_ptr, frames)`,
  `descriptors_ptr(handle) → (ptr, len)`.
- WASM imports from host: a small audio-safe API only — no network, no
  DOM, no allocations beyond the plugin's own `WebAssembly.Memory`.
- **Test:** A reference passthrough plugin written in Rust → compiled
  to WASM → loaded → produces identical output to a static
  passthrough.

### M3 — Plugin UI sandbox

- Plugin UI bundle is a JS module exporting `createUI(host: PluginHost)
  → HTMLElement`.
- Mounted inside a closed-shadow-root web component the host owns; the
  component restricts the host API surface to:
  `getParam(id)`, `setParam(id, value)`, `subscribe(id, cb)`,
  `getMeter(busId)`, `dispose()`.
- No network access (CSP `connect-src 'none'` for the plugin context;
  we serve plugin UIs from a separate origin with strict CSP, or use
  iframe sandbox for stronger isolation when COOP/COEP allows).
- **Test:** load a UI module, instantiate, twist a knob → host reports
  matching `setParam` call; UI cannot fetch arbitrary URLs.

### M4 — Plugin loader UX

- "Add Plugin from URL" entry in the instrument / FX picker.
- Paste URL → fetch manifest → verify integrity → fetch wasm + ui →
  show "Add to track" confirmation.
- Loaded plugins remembered in Y.Doc `meta.installedPlugins:
  Y.Map<id, manifest>` so reloading the project re-fetches them.
- Per-plugin permissions UI (currently just trust/untrust).
- **Test:** Playwright — paste URL of a static-served example plugin →
  added to FX picker → drop on a track → audible processing.

### M5 — Example external plugin

- Build one canonical external plugin to prove the contract end-to-end:
  a "Bitcrusher" effect (simple DSP, demonstrative UI).
- Lives in a separate folder (`examples/bitcrusher-plugin/`) with its
  own build (`wasm-pack`), produces a WASM + UI bundle that we host
  statically (e.g. in `/public/example-plugins/` for now).
- Plugin SDK README in `examples/bitcrusher-plugin/README.md` so
  third-parties can fork it.
- **Test:** loaded as a third-party from the example URL during
  Playwright tests; processes audio.

### M6 — Plugin registry (minimal)

- The "registry" is a JSON file: `{ plugins: [<manifest URL>, ...] }`
  hosted at a curated URL (or the user can paste their own registry
  URL).
- "Browse plugins" view = fetch registry → list → click → install.
- Decentralized by design: no central app store, just URLs.
- **Test:** point at a fixture registry → see the example plugin in
  the list → install.

## Verification (end of phase)

- **Manual:** Browse plugins → install Bitcrusher → drag onto a track
  → twist the bit-depth knob → hear quantization. Reload page → plugin
  still loaded and processing. Try an intentionally invalid URL or
  bad-integrity plugin → see a useful error, no crash.
- **Automated:**
  - `pnpm playwright test phase-7` — install/uninstall flow, persist
    across reload, integrity-check failure surfaces error.
  - `cargo test -p audio-engine wasm_plugin_runtime` — WASM dispatcher
    correctness, signal preservation through dispatch overhead.
  - `cargo build --target wasm32-unknown-unknown
    -p example-bitcrusher` — example plugin always builds in CI so the
    SDK contract doesn't drift.

## Critical files

- `crates/audio-engine/src/plugin_wasm.rs` — WASM plugin host inside
  engine.
- `packages/app/src/lib/plugin-loader.ts` — fetch, verify, instantiate.
- `packages/app/src/lib/plugin-ui-sandbox.ts` — web component +
  restricted host API.
- `packages/app/src/components/PluginPicker.svelte`,
  `PluginInstallDialog.svelte`, `PluginRegistryBrowser.svelte`.
- `examples/bitcrusher-plugin/` — reference plugin.
- `docs/plugin-sdk.md` — public SDK reference.

## Out of scope

- Plugin presets / patch sharing → Phase 9.
- Built-in plugin marketplace UI / payments → not in scope.
- VST/AU compatibility → explicitly out (anti-goal in dream).
- Plugin auto-update / version pinning UX polish → Phase 9.
