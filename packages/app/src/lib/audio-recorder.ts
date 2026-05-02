// Phase-5 M5: getUserMedia → Float32 PCM recorder.
//
// Wraps the AudioContext + MediaStreamSource + ScriptProcessorNode
// (a deprecated but universally-available capture path; M9 polish
// migrates to AudioWorkletNode-based capture for sample-accurate
// timing). Recorded chunks accumulate in a Float32 ring; on stop, we
// concatenate into a single mono Float32Array and hand it to the
// caller. The caller wraps the PCM in a WAV and runs it through the
// existing asset import pipeline.

export interface AudioRecorder {
  start(): Promise<void>;
  stop(): Promise<Float32Array>;
  destroy(): void;
  readonly sampleRate: number;
  readonly recording: boolean;
}

export interface AudioRecorderOptions {
  /// Optional override for the device id; null = browser default.
  deviceId?: string | null;
}

export async function createAudioRecorder(
  ctx: AudioContext,
  opts: AudioRecorderOptions = {},
): Promise<AudioRecorder> {
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  const chunks: Float32Array[] = [];
  let recording = false;

  const sampleRate = ctx.sampleRate;

  const start = async () => {
    if (recording) return;
    chunks.length = 0;
    const constraints: MediaStreamConstraints = {
      audio: opts.deviceId
        ? { deviceId: { exact: opts.deviceId } }
        : true,
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    source = ctx.createMediaStreamSource(stream);
    // 4096 samples ≈ 85 ms at 48 kHz — coarse but reliable. M9 polish
    // swaps in an AudioWorkletNode for sample-accurate capture.
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      // Copy out — the underlying buffer is reused.
      chunks.push(new Float32Array(data));
    };
    source.connect(processor);
    // ScriptProcessorNode needs a destination connection to fire its
    // onaudioprocess; route through a silent gain.
    processor.connect(ctx.destination);
    recording = true;
  };

  const stop = async (): Promise<Float32Array> => {
    if (!recording) return new Float32Array();
    recording = false;
    processor?.disconnect();
    source?.disconnect();
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    processor = null;
    source = null;
    stream = null;
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    chunks.length = 0;
    return out;
  };

  const destroy = () => {
    if (recording) {
      void stop();
    }
  };

  return {
    start,
    stop,
    destroy,
    sampleRate,
    get recording() {
      return recording;
    },
  };
}
