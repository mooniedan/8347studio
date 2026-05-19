<script lang="ts">
  import { onMount } from 'svelte';
  import { peaksFor } from './waveform-cache';

  /**
   * Phase-10 M3a — waveform thumbnail for one audio region.
   *
   * Renders a downsampled peak series into a `<canvas>` sized to the
   * region's pixel width. Re-draws when `hash` or `widthPx` changes.
   * Peak extraction is cached per asset-hash in `waveform-cache.ts`
   * so multiple regions of the same asset (or re-mounts) hit the
   * cached series instead of re-decoding.
   */
  const {
    hash,
    widthPx,
    heightPx = 64,
  }: {
    hash: string;
    widthPx: number;
    heightPx?: number;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  async function render() {
    if (!canvas) return;
    const w = Math.max(1, Math.floor(widthPx));
    const h = Math.max(1, Math.floor(heightPx));
    const dpr = window.devicePixelRatio || 1;
    // Backing-store size in device pixels; CSS size in CSS pixels.
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Bucket count is the CSS-pixel width — one peak-pair per
    // visible column. The browser handles HiDPI via the dpr scale.
    let pairs: Float32Array;
    try {
      pairs = await peaksFor(hash, w);
    } catch {
      // Decode failed (e.g. asset missing in test fixtures). Draw a
      // flat baseline so the region still has *some* visual content
      // and the canvas is detectable by tests.
      pairs = new Float32Array(0);
    }
    if (canvas == null) return; // unmounted while awaiting

    ctx.fillStyle = '#7ad776';
    if (pairs.length === 0) {
      // Baseline placeholder — single faint horizontal line.
      ctx.fillRect(0, Math.floor(h / 2), w, 1);
      return;
    }
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const minV = pairs[x * 2];     // negative
      const maxV = pairs[x * 2 + 1]; // positive
      const y0 = Math.round(mid + minV * mid);
      const y1 = Math.round(mid + maxV * mid);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  // Re-render whenever the asset hash or the requested pixel width
  // changes. `widthPx` changes when the region is moved/resized;
  // the bucket cache short-circuits the second hit.
  $effect(() => {
    void hash;
    void widthPx;
    void heightPx;
    void canvas;
    render();
  });

  onMount(() => { render(); });
</script>

<canvas
  bind:this={canvas}
  class="wave"
  data-testid={`waveform-${hash}`}
></canvas>

<style>
  .wave {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }
</style>
