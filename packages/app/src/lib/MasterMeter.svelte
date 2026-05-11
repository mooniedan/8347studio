<script lang="ts">
  /**
   * Phase 7 M3 — master stereo meter in the top transport bar.
   *
   * Taps the AudioWorklet output via an AnalyserNode, computes
   * peak + RMS per audio frame, and holds the peak for ~1.5s before
   * decaying — design semantics from the P0 spec (green→amber→clip
   * gradient, hold-line indicator).
   *
   * The worklet has a single output today (stereo will land when the
   * engine produces interleaved L/R); the meter renders two channel
   * bars driven by the same peak/rms until then so the layout is
   * already correct.
   */
  import { onMount } from 'svelte';
  import * as audio from './audio';
  import Meter from './ui/Meter.svelte';

  let { height = 28 }: { height?: number } = $props();

  let level = $state(0);
  let peak = $state(0);
  let peakAt = 0;
  const HOLD_MS = 1500;

  onMount(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void audio.ensureReady().then(({ node }) => {
      if (cancelled) return;
      const ctx = node.context as AudioContext;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const buf = new Float32Array(analyser.fftSize);
      node.connect(analyser);

      let raf = 0;
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let p = 0;
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          const a = Math.abs(v);
          if (a > p) p = a;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        level = rms;
        const now = performance.now();
        if (p >= peak || now - peakAt > HOLD_MS) {
          peak = p;
          peakAt = now;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(raf);
        try { node.disconnect(analyser); } catch { /* idempotent disconnect */ }
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  });
</script>

<div class="master-meter" data-testid="master-meter" aria-label="Master output level">
  <Meter
    orientation="horizontal"
    level={level}
    ariaLabel="Master L"
    testId="master-meter-l"
  />
  <Meter
    orientation="horizontal"
    level={level}
    ariaLabel="Master R"
    testId="master-meter-r"
  />
  <span class="db num" data-testid="master-meter-peak">
    {peak <= 0.0001 ? '-∞' : (20 * Math.log10(peak)).toFixed(1)}
  </span>
</div>

<style>
  .master-meter {
    display: grid;
    grid-template-columns: 1fr 38px;
    grid-template-rows: auto auto;
    align-items: center;
    gap: 2px var(--sp-2);
    width: 140px;
    padding: 0 var(--sp-2);
    border-left: 1px solid var(--line-1);
    border-right: 1px solid var(--line-1);
    height: 100%;
  }
  .master-meter :global(.h-meter) {
    grid-column: 1;
  }
  .master-meter :global(.h-meter:first-of-type) { grid-row: 1; }
  .master-meter :global(.h-meter:nth-of-type(2)) { grid-row: 2; }
  .db {
    grid-column: 2;
    grid-row: 1 / span 2;
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-1);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
