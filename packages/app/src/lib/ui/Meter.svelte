<script lang="ts">
  /**
   * Vertical segmented LED meter. `level` and `peak` are 0..1.
   * The host computes dBFS → 0..1 (Phase 7 M3 wires the master meter
   * via engine-bridge SAB to this).
   */
  let {
    level = 0,
    peak = 0,
    height = 160,
    width = 10,
    orientation = 'vertical',
    ariaLabel,
    testId,
  }: {
    level?: number;
    peak?: number;
    height?: number;
    width?: number;
    orientation?: 'vertical' | 'horizontal';
    ariaLabel?: string;
    testId?: string;
  } = $props();

  const clamped = $derived(Math.min(1, Math.max(0, level)));
  const peakClamped = $derived(Math.min(1, Math.max(0, peak)));
</script>

{#if orientation === 'vertical'}
  <div
    class="meter"
    style:height="{height}px"
    style:width="{width}px"
    style:--val={clamped}
    style:--peak={peakClamped}
    role="meter"
    aria-valuenow={clamped}
    aria-valuemin={0}
    aria-valuemax={1}
    aria-label={ariaLabel}
    data-testid={testId}
  >
    <div class="segs"></div>
    {#if peakClamped > 0}<div class="peak"></div>{/if}
  </div>
{:else}
  <div
    class="h-meter"
    style:--val={clamped}
    role="meter"
    aria-valuenow={clamped}
    aria-valuemin={0}
    aria-valuemax={1}
    aria-label={ariaLabel}
    data-testid={testId}
  ></div>
{/if}

<style>
  .meter {
    background: var(--meter-bg);
    border: 1px solid var(--line-0);
    border-radius: 1px;
    position: relative;
    box-shadow: var(--shadow-inset);
    overflow: hidden;
  }
  .meter .segs {
    position: absolute;
    inset: 1px;
    background: linear-gradient(0deg,
      var(--meter-ok)   0%,
      var(--meter-ok)   60%,
      var(--meter-warn) 60%,
      var(--meter-warn) 85%,
      var(--meter-clip) 85%,
      var(--meter-clip) 100%);
    -webkit-mask: repeating-linear-gradient(0deg, black 0 4px, transparent 4px 6px);
            mask: repeating-linear-gradient(0deg, black 0 4px, transparent 4px 6px);
    clip-path: inset(calc((1 - var(--val)) * 100%) 0 0 0);
    filter: brightness(1.05);
  }
  .meter .peak {
    position: absolute;
    left: 1px; right: 1px;
    bottom: calc(var(--peak) * 100%);
    height: 2px;
    background: var(--fg-0);
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
  }

  .h-meter {
    width: 100%;
    height: 4px;
    background: var(--meter-bg);
    border-radius: 1px;
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line-0);
  }
  .h-meter::after {
    content: "";
    position: absolute;
    inset: 0;
    width: calc(var(--val) * 100%);
    background: linear-gradient(90deg,
      var(--meter-ok)   0%,
      var(--meter-ok)   70%,
      var(--meter-warn) 70%,
      var(--meter-warn) 90%,
      var(--meter-clip) 90%);
  }
</style>
