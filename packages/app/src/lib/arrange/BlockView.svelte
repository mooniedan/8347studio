<script lang="ts">
  // A single placed item on an arrangement lane — a MIDI block or an
  // audio region. M4 adds drag-move (body), right-edge resize, click
  // select, and double-click drill-in. Pure presentational: the lane
  // computes pixel geometry and owns the drag state machine; this
  // component just forwards the gestures.
  const {
    left,
    width,
    label,
    color,
    startTick = 0,
    lengthTicks = 0,
    loop = false,
    selected = false,
    editable = false,
    testid,
    onPointerDownBody = () => {},
    onPointerDownResize = () => {},
    onDblClick = () => {},
  }: {
    left: number;
    width: number;
    label: string;
    color: string;
    startTick?: number;
    lengthTicks?: number;
    loop?: boolean;
    selected?: boolean;
    editable?: boolean;
    testid?: string;
    onPointerDownBody?: (e: PointerEvent) => void;
    onPointerDownResize?: (e: PointerEvent) => void;
    onDblClick?: (e: MouseEvent) => void;
  } = $props();
</script>

<div
  class="block"
  class:selected
  class:editable
  data-testid={testid}
  data-start-tick={startTick}
  data-length-ticks={lengthTicks}
  data-loop={loop}
  style:left="{left}px"
  style:width="{Math.max(2, width)}px"
  style:--block-color={color}
  title={label}
  onpointerdown={(e) => onPointerDownBody(e)}
  ondblclick={(e) => onDblClick(e)}
>
  <span class="blk-label">{label}</span>
  {#if loop}<span class="blk-loop" title="loops to fill">↻</span>{/if}
  {#if editable}
    <span
      class="resize-r"
      data-testid="{testid}-resize"
      onpointerdown={(e) => { e.stopPropagation(); onPointerDownResize(e); }}
    ></span>
  {/if}
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
  .block.editable {
    cursor: grab;
  }
  .block.selected {
    border-color: var(--accent-hi, #6cf);
    box-shadow: 0 0 0 1px var(--accent-hi, #6cf) inset;
  }
  .blk-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .blk-loop {
    margin-left: auto;
    opacity: 0.7;
    font-size: 10px;
    pointer-events: none;
  }
  .resize-r {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 7px;
    cursor: ew-resize;
    background: linear-gradient(
      to right,
      transparent,
      color-mix(in srgb, var(--block-color) 70%, transparent)
    );
  }
</style>
