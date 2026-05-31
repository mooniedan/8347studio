<script lang="ts">
  import { PX_PER_TICK, BAR_TICKS, RULER_HEIGHT } from './timeline';

  const { totalTicks }: { totalTicks: number } = $props();

  const bars = $derived(Math.max(1, Math.ceil(totalTicks / BAR_TICKS)));
  const widthPx = $derived(totalTicks * PX_PER_TICK);
  const barPx = $derived(BAR_TICKS * PX_PER_TICK);
</script>

<div
  class="ruler"
  data-testid="arrange-ruler"
  style:width="{widthPx}px"
  style:height="{RULER_HEIGHT}px"
>
  {#each Array(bars) as _, i (i)}
    <div class="bar" style:left="{i * barPx}px">
      <span class="num">{i + 1}</span>
    </div>
  {/each}
</div>

<style>
  .ruler {
    position: relative;
    flex: 0 0 auto;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border, #333);
  }
  .bar {
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--border, #333);
  }
  .num {
    position: absolute;
    left: 4px;
    top: 4px;
    font-size: 10px;
    color: var(--fg-3, #888);
    font-variant-numeric: tabular-nums;
  }
</style>
