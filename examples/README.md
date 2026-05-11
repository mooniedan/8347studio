# 8347 Studio — third-party plugin SDK

> Phase 8 work-in-progress. The ABI here is the public seam every
> third-party plugin must satisfy. It is **append-only** once stable.

Plugins ship as a `.wasm` module + a JSON manifest. The host fetches
the manifest, verifies the integrity hash, instantiates the WASM, and
calls a small set of C-style exports to drive the plugin from the
audio engine.

## ABI

Every plugin WASM **must** export:

```c
// Allocate a buffer of `size` bytes inside the plugin's memory.
// The loader uses this to hand the plugin input audio and to discover
// where to read output audio from. Lifetime is owned by the plugin —
// `destroy(handle)` is responsible for any cleanup that matters.
// Returns the offset into the plugin's WebAssembly.Memory.
usize alloc(u32 size);

// Construct a plugin instance for the given sample rate + max audio
// block size. Returns a handle the loader passes back into every
// subsequent call. Plugins should preallocate all per-instance
// buffers here — `process` MUST be allocation-free.
usize init(f32 sample_rate, u32 max_block_size);

// Tear down an instance. The plugin should release any memory it
// reserved in `init`. After this call the handle is invalid.
void destroy(usize handle);

// Set a parameter by numeric id. Param ids are assigned by manifest
// order (params[0] → id 0, params[1] → id 1, …) unless the manifest
// overrides via the optional `numericId` field on a descriptor.
void set_param(usize handle, u32 id, f32 value);

// Read back the current value of a parameter. Used by the host for
// automation echoes + MIDI Learn surface state.
f32 get_param(usize handle, u32 id);

// Deliver an audio-thread event. `kind` is one of:
//   0 = NoteOn        (p1 = pitch 0..127, p2 = velocity 0..127)
//   1 = NoteOff       (p1 = pitch)
//   2 = MidiCc        (p1 = cc number 0..127, p2 = value 0..127)
//   3 = AllNotesOff
void handle_event(usize handle, u32 kind, u32 p1, u32 p2);

// Render `frames` samples. `in_ptr` points to `in_channels * frames`
// f32 samples (channels interleaved); `out_ptr` is the buffer the
// plugin writes output into (replace, not accumulate).
// Instrument plugins receive an empty input (in_channels = 0) and
// produce sound from internal state. Effect plugins read input and
// produce processed output.
void process(
    usize handle,
    *const f32 in_ptr,  u32 in_channels,
    *mut f32   out_ptr, u32 out_channels,
    u32 frames
);
```

The loader provides **no imports** to plugins in M3a — the plugin's
WebAssembly.Memory is the only state surface. M3b adds a tiny
host-imports surface (sample-rate query, log-for-debug). Plugins
have **no DOM, network, or filesystem access** by design.

## Manifest

See `packages/app/src/lib/plugin-manifest.ts` for the schema.
Minimal:

```json
{
  "id": "com.example.gain",
  "name": "Gain",
  "version": "0.1.0",
  "kind": "effect",
  "wasm": "/example-plugins/wasm-gain-plugin.wasm",
  "wasmIntegrity": "sha256-…",
  "params": [
    { "id": "gain", "name": "Gain", "min": 0, "max": 1, "default": 1, "curve": "linear" }
  ]
}
```

Params are addressed by numeric id (position in the array) at the
ABI level; the manifest's string `id` is the display key.

## Example plugins

- `wasm-gain-plugin/` — minimal 1-param effect; used by M3a's loader
  tests as the reference fixture.
