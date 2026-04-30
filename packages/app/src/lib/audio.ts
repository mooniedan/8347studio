let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let readyPromise: Promise<void> | null = null;
let stepListener: ((step: number) => void) | null = null;

async function ensureReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/worklet/processor.js');
    const bytes = await fetch('/wasm_bridge.wasm').then((r) => r.arrayBuffer());
    node = new AudioWorkletNode(ctx, 'daw-processor', { outputChannelCount: [2] });
    const ready = new Promise<void>((resolve) => {
      node!.port.onmessage = (e) => {
        if (e.data?.type === 'ready') resolve();
        else if (e.data?.type === 'step') stepListener?.(e.data.step);
      };
    });
    node.port.postMessage({ type: 'init', bytes }, [bytes]);
    await ready;
    node.connect(ctx.destination);
  })();
  return readyPromise;
}

export function onStep(fn: (step: number) => void): void {
  stepListener = fn;
}

export async function play(): Promise<void> {
  await ensureReady();
  if (ctx!.state === 'suspended') await ctx!.resume();
  node!.port.postMessage({ type: 'setPlaying', on: true });
}

export async function stop(): Promise<void> {
  if (!node) return;
  node.port.postMessage({ type: 'setPlaying', on: false });
}

export async function setStepMask(i: number, mask: number): Promise<void> {
  await ensureReady();
  node!.port.postMessage({ type: 'setStepMask', i, mask });
}

export async function setBpm(bpm: number): Promise<void> {
  await ensureReady();
  node!.port.postMessage({ type: 'setBpm', bpm });
}

export type Waveform = 'sine' | 'saw' | 'square';
const WAVEFORM_CODE: Record<Waveform, number> = { sine: 0, saw: 1, square: 2 };

export async function setWaveform(w: Waveform): Promise<void> {
  await ensureReady();
  node!.port.postMessage({ type: 'setWaveform', w: WAVEFORM_CODE[w] });
}
