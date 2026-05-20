// Phase-10 M7d — offline render worker.
//
// Hosts an independent instance of the engine WASM (separate from the
// realtime AudioWorklet) and renders a project snapshot to interleaved
// stereo PCM, off the main thread. Driven once per render by render.ts.
//
// Third-party WASM-plugin inserts are not rendered offline (the
// host_plugin_* imports are stubbed); first-party DSP, the synth,
// sequencer and audio regions all render. This is noted in the UI.

interface RenderRequest {
  wasmBytes: ArrayBuffer;
  snapshot: Uint8Array;
  assets: { id: number; pcm: Float32Array }[];
  sampleRate: number;
  endTick: number;
  maxFrames: number;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<RenderRequest>) => {
  const { wasmBytes, snapshot, assets, sampleRate, endTick, maxFrames } = e.data;
  try {
    const imports = {
      env: {
        host_plugin_set_param: () => {},
        host_plugin_get_param: () => 0,
        host_plugin_handle_event: () => {},
        host_plugin_process: () => {},
      },
    };
    const mod = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(mod, imports);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const x = instance.exports as any;
    const mem = () => new Uint8Array((x.memory as WebAssembly.Memory).buffer);

    x.init(sampleRate);

    // Register asset PCM BEFORE applying the snapshot, mirroring the
    // realtime ordering so audio regions resolve their cache entries.
    for (const a of assets) {
      const ptr = x.asset_buffer_reserve(a.pcm.length) >>> 0;
      new Float32Array((x.memory as WebAssembly.Memory).buffer, ptr, a.pcm.length).set(a.pcm);
      x.register_asset(a.id >>> 0, a.pcm.length);
    }

    // Apply the project snapshot.
    const sptr = x.snapshot_buffer_reserve(snapshot.length) >>> 0;
    mem().set(snapshot, sptr);
    x.rebuild_project(snapshot.length);

    // Render.
    const frames = x.offline_render(endTick, maxFrames) >>> 0;
    const ptr = x.render_buffer_ptr() >>> 0;
    const view = new Float32Array((x.memory as WebAssembly.Memory).buffer, ptr, frames * 2);
    const pcm = new Float32Array(view); // copy out of wasm memory

    scope.postMessage({ ok: true, pcm, frames }, [pcm.buffer]);
  } catch (err) {
    scope.postMessage({ ok: false, error: String(err) });
  }
};
