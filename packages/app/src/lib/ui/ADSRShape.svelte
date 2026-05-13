<script lang="ts">
  /**
   * Phase 8 M8 — read-only envelope shape view.
   *
   * Renders an SVG polyline tracing a classic Attack/Decay/Sustain/
   * Release contour. Values are in seconds (A/D/R) and 0..1 sustain
   * level. The total time displayed is normalized — the curve's
   * x-axis scales to fit whatever A+D+sustainHold+R adds up to, so
   * the shape stays informative regardless of absolute durations.
   *
   * No drag interaction in M8: a future polish can let the user
   * grab corner points. For now the four sliders below drive it.
   */
  let {
    attack,
    decay,
    sustain,
    release,
    width = 200,
    height = 64,
    sustainHold = 0.3,
  }: {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    width?: number;
    height?: number;
    /** Time spent in the sustain phase before release (display
     *  only — gives the curve a flat plateau between the decay and
     *  release ramps). */
    sustainHold?: number;
  } = $props();

  const a = $derived(Math.max(0.001, attack));
  const d = $derived(Math.max(0.001, decay));
  const s = $derived(Math.max(0, Math.min(1, sustain)));
  const r = $derived(Math.max(0.001, release));
  const total = $derived(a + d + sustainHold + r);

  const points = $derived.by(() => {
    // SVG y goes top-down; envelope amplitude is bottom-up, so we
    // invert. Inset by 4 so endpoints don't sit on the border.
    const w = width;
    const h = height;
    const inset = 4;
    const ph = h - inset * 2;
    const pw = w - inset * 2;
    const x = (t: number) => inset + (t / total) * pw;
    const y = (level: number) => inset + (1 - level) * ph;
    const tA = a;
    const tB = tA + d;
    const tC = tB + sustainHold;
    const tD = total;
    return [
      [x(0), y(0)],
      [x(tA), y(1)],
      [x(tB), y(s)],
      [x(tC), y(s)],
      [x(tD), y(0)],
    ]
      .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
      .join(' ');
  });
</script>

<svg
  class="adsr"
  viewBox="0 0 {width} {height}"
  width={width}
  height={height}
  role="img"
  aria-label="ADSR envelope shape"
  data-testid="adsr-shape"
>
  <!-- grid baselines -->
  <line x1="4" y1={height - 4} x2={width - 4} y2={height - 4} class="axis" />
  <polyline points={points} class="curve" />
</svg>

<style>
  .adsr {
    background: var(--bg-0);
    border: 1px solid var(--line-0);
    border-radius: var(--r-sm);
    display: block;
  }
  .axis {
    stroke: var(--fg-3);
    stroke-width: 0.5;
    stroke-dasharray: 2 3;
  }
  .curve {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
    filter: drop-shadow(0 0 2px rgba(226, 52, 45, 0.4));
  }
</style>
