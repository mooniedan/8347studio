class DawProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.lastStep = -1;
    this.port.onmessage = (e) => this.handle(e.data);
  }

  async handle(msg) {
    if (msg.type === 'init') {
      const mod = await WebAssembly.compile(msg.bytes);
      this.instance = await WebAssembly.instantiate(mod, {});
      const x = this.instance.exports;
      x.init(sampleRate);
      this.bufPtr = x.alloc(128);
      this.memF32 = () => new Float32Array(x.memory.buffer, this.bufPtr, 128);
      this.exports = x;
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } else if (!this.ready) {
      return;
    } else if (msg.type === 'setStepMask') {
      this.exports.set_step_mask(msg.i >>> 0, msg.mask >>> 0);
    } else if (msg.type === 'setBpm') {
      this.exports.set_bpm(msg.bpm);
    } else if (msg.type === 'setWaveform') {
      this.exports.set_waveform(msg.w >>> 0);
    } else if (msg.type === 'setPlaying') {
      this.exports.set_playing(msg.on ? 1 : 0);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.ready) return true;
    this.exports.process(this.bufPtr, 128);
    const src = this.memF32();
    for (let ch = 0; ch < out.length; ch++) {
      out[ch].set(src);
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
