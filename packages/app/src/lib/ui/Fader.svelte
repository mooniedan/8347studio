<script lang="ts">
  /**
   * Vertical channel-strip fader. Drag the cap vertically to change.
   * Value mapping is the host's job — pass the raw 0..1 here.
   * Optional dB-scale tick labels.
   */
  let {
    value = $bindable(),
    min = 0,
    max = 1,
    height = 160,
    scale = ['+6', '0', '-6', '-18', '-∞'],
    ariaLabel,
    testId,
    disabled = false,
  }: {
    value: number;
    min?: number;
    max?: number;
    height?: number;
    scale?: string[];
    ariaLabel?: string;
    testId?: string;
    disabled?: boolean;
  } = $props();

  const norm = $derived((value - min) / (max - min));
  let rail: HTMLDivElement;
  let dragging = $state(false);

  function setFromClientY(clientY: number) {
    const rect = rail.getBoundingClientRect();
    let t = 1 - (clientY - rect.top) / rect.height;
    t = Math.min(1, Math.max(0, t));
    const next = min + t * (max - min);
    if (next !== value) value = next;
  }

  function onpointerdown(e: PointerEvent) {
    if (disabled) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
    setFromClientY(e.clientY);
  }
  function onpointermove(e: PointerEvent) {
    if (!dragging) return;
    setFromClientY(e.clientY);
  }
  function onpointerup(e: PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragging = false;
  }
  function onkeydown(e: KeyboardEvent) {
    if (disabled) return;
    const range = max - min;
    const s = e.shiftKey ? range / 1000 : range / 100;
    if (e.key === 'ArrowDown') {
      value = Math.max(min, value - s); e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      value = Math.min(max, value + s); e.preventDefault();
    }
  }
</script>

<div
  class="fader"
  class:disabled
  style:height="{height}px"
  style:--val={norm}
  role="slider"
  aria-orientation="vertical"
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-label={ariaLabel}
  tabindex={disabled ? -1 : 0}
  data-testid={testId}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  {onkeydown}
>
  <div class="scale" aria-hidden="true">
    {#each scale as s (s)}<span>{s}</span>{/each}
  </div>
  <div class="rail" bind:this={rail}>
    <div class="cap"></div>
  </div>
</div>

<style>
  .fader {
    width: 30px;
    position: relative;
    display: flex;
    justify-content: center;
    cursor: ns-resize;
  }
  .fader.disabled { cursor: not-allowed; opacity: 0.45; }
  .fader:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm); }

  .scale {
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;
  }
  .scale span {
    font-family: var(--font-mono);
    font-size: 8px;
    color: var(--fg-3);
    text-align: right;
    padding-right: 22px;
    line-height: 1;
  }
  .rail {
    width: 4px;
    height: 100%;
    background: var(--bg-0);
    border: 1px solid var(--line-0);
    border-radius: 2px;
    box-shadow: var(--shadow-inset);
    position: relative;
  }
  .rail::after {
    content: "";
    position: absolute;
    left: -6px; right: -6px;
    top: 28%;
    height: 1px;
    background: var(--fg-3);
  }
  .cap {
    position: absolute;
    left: 50%;
    bottom: calc(var(--val) * 100% - 14px);
    transform: translateX(-50%);
    width: 22px;
    height: 28px;
    border-radius: 3px;
    background:
      linear-gradient(180deg, #3a3e48 0%, #20232a 45%, #0c0d10 55%, #20232a 100%);
    border: 1px solid #000;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.18),
      0 2px 4px rgba(0, 0, 0, 0.9);
  }
  .cap::after {
    content: "";
    position: absolute;
    left: 2px; right: 2px;
    top: 50%;
    height: 2px;
    background: var(--accent);
    border-radius: 1px;
    box-shadow: 0 0 4px rgba(226, 52, 45, 0.6);
    transform: translateY(-50%);
  }
</style>
