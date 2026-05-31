<script lang="ts">
  // A single placed item on an arrangement lane — a MIDI block or an
  // audio region. Read-only in M3 (drag handles land in M4). Pure
  // presentational: the lane computes pixel geometry and passes it in.
  const {
    left,
    width,
    label,
    color,
    startTick = 0,
    lengthTicks = 0,
    loop = false,
    selected = false,
    testid,
  }: {
    left: number;
    width: number;
    label: string;
    color: string;
    startTick?: number;
    lengthTicks?: number;
    loop?: boolean;
    selected?: boolean;
    testid?: string;
  } = $props();
</script>

<div
  class="block"
  class:selected
  data-testid={testid}
  data-start-tick={startTick}
  data-length-ticks={lengthTicks}
  data-loop={loop}
  style:left="{left}px"
  style:width="{Math.max(2, width)}px"
  style:--block-color={color}
  title={label}
>
  <span class="blk-label">{label}</span>
  {#if loop}<span class="blk-loop" title="loops to fill">↻</span>{/if}
</div>

<style>
  .block {
    position: absolute;
    top: 4px;
    bottom: 4px;
    box-sizing: border-box;
    border-radius: 4px;
    background: color-mix(in srgb, var(--block-color) 32%, var(--bg-2));
    border: 1px solid color-mix(in srgb, var(--block-color) 60%, transparent);
    border-left: 3px solid var(--block-color);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    overflow: hidden;
    font-size: 11px;
    color: var(--fg-1);
    user-select: none;
    cursor: default;
  }
  .block.selected {
    border-color: var(--accent-hi, #6cf);
    box-shadow: 0 0 0 1px var(--accent-hi, #6cf) inset;
  }
  .blk-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .blk-loop {
    margin-left: auto;
    opacity: 0.7;
    font-size: 10px;
  }
</style>
