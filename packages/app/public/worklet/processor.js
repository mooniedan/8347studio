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
    this.port.onmessage = (e) => this.handle(e.data);
  }

  async handle(msg) {
    if (msg.type === 'init') {
      const mod = await WebAssembly.compile(msg.bytes);
      this.instance = await WebAssembly.instantiate(mod, {});
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
    } else if (msg.type === 'rebuild') {
      const bytes = msg.bytes;
      const ptr = this.exports.snapshot_buffer_reserve(bytes.length);
      const dst = new Uint8Array(this.exports.memory.buffer, ptr, bytes.length);
      dst.set(bytes);
      this.exports.rebuild_project(bytes.length);
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
      }
      this.port.postMessage({ type: 'debug-reply', id: msg.id, what: msg.what, value });
    } else if (msg.type === 'setStepMask') {
      this.exports.set_step_mask(msg.i >>> 0, msg.mask >>> 0);
    } else if (msg.type === 'setWaveform') {
      this.exports.set_waveform(msg.w >>> 0);
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
