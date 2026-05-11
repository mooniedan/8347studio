// AudioWorklet processor for 8347 Studio.
//
// Hosts the wasm engine (audio-engine + wasm-bridge), drains the SAB
// event ring at the start of every audio block, and handles structural
// rebuild messages on the main-thread channel.

const HEADER_BYTES = 8;
const HEAD_OFFSET = 0;
const TAIL_OFFSET = 4;
const DATA_OFFSET = HEADER_BYTES;
const LEN_PREFIX_BYTES = 4;

class RingReader {
  constructor(sab) {
    this.head = new Int32Array(sab, HEAD_OFFSET, 1);
    this.tail = new Int32Array(sab, TAIL_OFFSET, 1);
    const cap = sab.byteLength - HEADER_BYTES;
    this.data = new Uint8Array(sab, DATA_OFFSET, cap);
    this.mask = cap - 1;
  }

  /// Pull the next event payload, or null if the ring is empty / mid-write.
  /// Allocates a Uint8Array per event — the worklet only sees a few per
  /// block so this is acceptable.
  next() {
    const head = Atomics.load(this.head, 0) >>> 0;
    let tail = Atomics.load(this.tail, 0) >>> 0;
    const available = (head - tail) >>> 0;
    if (available < LEN_PREFIX_BYTES) return null;
    let len = 0;
    for (let i = 0; i < 4; i++) {
      len |= this.data[(tail + i) & this.mask] << (i * 8);
    }
    len >>>= 0;
    const total = LEN_PREFIX_BYTES + len;
    if (available < total) return null;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = this.data[(tail + LEN_PREFIX_BYTES + i) & this.mask];
    }
    Atomics.store(this.tail, 0, (tail + total) >>> 0);
    return out;
  }
}

class DawProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.lastStep = -1;
    this.reader = null;
    // Phase-8 M3b: registry of third-party WASM plugin instances. The
    // engine reaches into this via the four host_plugin_* imports it
    // declares; handles are u32 keys assigned monotonically when the
    // main thread asks us to load a plugin.
    this.wasmPlugins = new Map();
    this.nextPluginHandle = 1;
    this.port.onmessage = (e) => this.handle(e.data);
  }

  async handle(msg) {
    if (msg.type === 'init') {
      const mod = await WebAssembly.compile(msg.bytes);
      const imports = {
        env: {
          host_plugin_set_param: (handle, id, value) => {
            const p = this.wasmPlugins.get(handle >>> 0);
            if (p) p.exports.set_param(p.instanceHandle, id >>> 0, value);
          },
          host_plugin_get_param: (handle, id) => {
            const p = this.wasmPlugins.get(handle >>> 0);
            return p ? p.exports.get_param(p.instanceHandle, id >>> 0) : 0;
          },
          host_plugin_handle_event: (handle, kind, p1, p2) => {
            const p = this.wasmPlugins.get(handle >>> 0);
            if (p) p.exports.handle_event(p.instanceHandle, kind >>> 0, p1 >>> 0, p2 >>> 0);
          },
          host_plugin_process: (handle, inPtr, inChannels, outPtr, outChannels, frames) => {
            const p = this.wasmPlugins.get(handle >>> 0);
            if (!p) return;
            const N = frames >>> 0;
            const inCh = inChannels >>> 0;
            const outCh = outChannels >>> 0;
            // Copy engine-memory inputs into the plugin's in-buffer.
            // Engine outputs come back from the plugin's out-buffer.
            // The engine produces ONE channel today (mono mix); we
            // map plugin output channels to that same buffer.
            const engineMem = this.exports.memory.buffer;
            const pluginMem = p.exports.memory.buffer;
            const inputTotal = N * inCh;
            const outputTotal = N * outCh;
            if (inCh > 0 && inPtr) {
              const src = new Float32Array(engineMem, inPtr, inputTotal);
              const dst = new Float32Array(pluginMem, p.inBufPtr, inputTotal);
              dst.set(src);
            }
            p.exports.process(p.instanceHandle, p.inBufPtr, inCh, p.outBufPtr, outCh, N);
            if (outCh > 0 && outPtr) {
              // Plugin memory may have grown (its allocator may have
              // expanded); refresh the view before reading.
              const out = new Float32Array(p.exports.memory.buffer, p.outBufPtr, outputTotal);
              const engineDst = new Float32Array(this.exports.memory.buffer, outPtr, outputTotal);
              engineDst.set(out);
            }
          },
        },
      };
      this.instance = await WebAssembly.instantiate(mod, imports);
      const x = this.instance.exports;
      x.init(sampleRate);
      // 128 samples × 4 bytes/f32 = 512-byte mono block buffer.
      this.bufPtr = x.alloc(512);
      this.audioView = new Float32Array(x.memory.buffer, this.bufPtr, 128);
      this.exports = x;
      if (msg.ring) {
        this.reader = new RingReader(msg.ring);
      }
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } else if (!this.ready) {
      return;
    } else if (msg.type === 'loadWasmPlugin') {
      // Main thread sends already-fetched + integrity-verified WASM
      // bytes (the loader handles fetch/SRI). We instantiate inside
      // the worklet so the plugin's WebAssembly.Memory lives in this
      // context, where the host_plugin_process import can copy
      // engine ↔ plugin memory without crossing thread boundaries.
      try {
        const pmod = await WebAssembly.compile(msg.bytes);
        const pinst = await WebAssembly.instantiate(pmod, {});
        const pexp = pinst.exports;
        const handle = this.nextPluginHandle++;
        const blockSize = (msg.maxBlockSize >>> 0) || 256;
        const outChannels = (msg.outChannels >>> 0) || 1;
        const inChannels = (msg.inChannels >>> 0) || 0;
        const instanceHandle = pexp.init(sampleRate, blockSize);
        const inBufPtr = inChannels > 0 ? pexp.alloc(blockSize * inChannels * 4) : 0;
        const outBufPtr = pexp.alloc(blockSize * outChannels * 4);
        this.wasmPlugins.set(handle, {
          exports: pexp,
          instanceHandle,
          inBufPtr,
          outBufPtr,
        });
        this.port.postMessage({ type: 'loadWasmPlugin-reply', id: msg.id, handle });
      } catch (err) {
        this.port.postMessage({
          type: 'loadWasmPlugin-reply',
          id: msg.id,
          handle: 0,
          error: String(err),
        });
      }
    } else if (msg.type === 'unloadWasmPlugin') {
      const h = msg.handle >>> 0;
      const p = this.wasmPlugins.get(h);
      if (p) {
        try { p.exports.destroy(p.instanceHandle); } catch { /* idempotent */ }
        this.wasmPlugins.delete(h);
      }
    } else if (msg.type === 'rebuild') {
      const bytes = msg.bytes;
      const ptr = this.exports.snapshot_buffer_reserve(bytes.length);
      const dst = new Uint8Array(this.exports.memory.buffer, ptr, bytes.length);
      dst.set(bytes);
      this.exports.rebuild_project(bytes.length);
    } else if (msg.type === 'registerAsset') {
      // Phase-5 M2: copy decoded PCM into the engine's asset cache.
      const pcm = msg.pcm; // Float32Array
      const ptr = this.exports.asset_buffer_reserve(pcm.length);
      const dst = new Float32Array(this.exports.memory.buffer, ptr, pcm.length);
      dst.set(pcm);
      this.exports.register_asset(msg.assetId >>> 0, pcm.length);
    } else if (msg.type === 'debug') {
      let value = NaN;
      if (msg.what === 'trackGain') {
        value = this.exports.debug_track_gain(msg.track >>> 0);
      } else if (msg.what === 'masterGain') {
        value = this.exports.debug_master_gain();
      } else if (msg.what === 'trackCount') {
        value = this.exports.debug_track_count();
      } else if (msg.what === 'currentTick') {
        value = this.exports.debug_current_tick();
      } else if (msg.what === 'bpm') {
        value = this.exports.debug_bpm();
      } else if (msg.what === 'trackPeak') {
        value = this.exports.debug_track_peak(msg.track >>> 0);
      } else if (msg.what === 'trackParam') {
        value = this.exports.debug_track_param(msg.track >>> 0, msg.paramId >>> 0);
      } else if (msg.what === 'assetCount') {
        value = this.exports.debug_asset_count();
      } else if (msg.what === 'loopEnd') {
        value = this.exports.debug_loop_end();
      }
      this.port.postMessage({ type: 'debug-reply', id: msg.id, what: msg.what, value });
    } else if (msg.type === 'setStepMask') {
      this.exports.set_step_mask(msg.track >>> 0, msg.i >>> 0, msg.mask >>> 0);
    } else if (msg.type === 'setWaveform') {
      this.exports.set_waveform(msg.track >>> 0, msg.w >>> 0);
    } else if (msg.type === 'setPlaying') {
      this.exports.set_playing(msg.on ? 1 : 0);
    }
  }

  drainRingInto(x) {
    if (!this.reader) return;
    let payload;
    while ((payload = this.reader.next())) {
      const ptr = x.event_buffer_reserve(payload.length);
      const dst = new Uint8Array(x.memory.buffer, ptr, payload.length);
      dst.set(payload);
      x.apply_event(payload.length);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.ready) return true;
    this.drainRingInto(this.exports);
    this.exports.process(this.bufPtr, 128);
    // memory may have been resized by the wasm side (Vec growth) — re-view
    // before reading.
    const view = new Float32Array(this.exports.memory.buffer, this.bufPtr, 128);
    for (let ch = 0; ch < out.length; ch++) {
      out[ch].set(view);
    }
    const step = this.exports.get_current_step();
    if (step !== this.lastStep) {
      this.lastStep = step;
      this.port.postMessage({ type: 'step', step });
    }
    return true;
  }
}

registerProcessor('daw-processor', DawProcessor);
