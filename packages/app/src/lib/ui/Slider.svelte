<script lang="ts">
  let {
    value = $bindable(),
    min = 0,
    max = 1,
    step = 0,
    width = 140,
    ariaLabel,
    testId,
    disabled = false,
  }: {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    width?: number;
    ariaLabel?: string;
    testId?: string;
    disabled?: boolean;
  } = $props();

  let track: HTMLDivElement;

  const norm = $derived((value - min) / (max - min));

  function setFromClientX(clientX: number) {
    const rect = track.getBoundingClientRect();
    let t = (clientX - rect.left) / rect.width;
    t = Math.min(1, Math.max(0, t));
    let next = min + t * (max - min);
    if (step > 0) next = Math.round((next - min) / step) * step + min;
    next = Math.min(max, Math.max(min, next));
    if (next !== value) value = next;
  }

  function onpointerdown(e: PointerEvent) {
    if (disabled) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  }
  function onpointermove(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    setFromClientX(e.clientX);
  }
  function onkeydown(e: KeyboardEvent) {
    if (disabled) return;
    const s = step > 0 ? step : (max - min) / 100;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      value = Math.max(min, value - s); e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      value = Math.min(max, value + s); e.preventDefault();
    }
  }
</script>

<div
  class="slider"
  class:disabled
  style:width="{width}px"
  style:--val={norm}
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-label={ariaLabel}
  data-testid={testId}
  {onpointerdown}
  {onpointermove}
  {onkeydown}
>
  <div class="track" bind:this={track}>
    <div class="fill"></div>
  </div>
  <div class="thumb"></div>
</div>

<style>
  .slider {
    height: 18px;
    position: relative;
    display: flex;
    align-items: center;
    cursor: pointer;
  }
  .slider.disabled { opacity: 0.45; cursor: not-allowed; }
  .slider:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm); }
  .track {
    width: 100%;
    height: 4px;
    background: var(--bg-0);
    border-radius: 2px;
    border: 1px solid var(--line-0);
    box-shadow: var(--shadow-inset);
    position: relative;
    overflow: hidden;
  }
  .fill {
    position: absolute;
    inset: 0;
    width: calc(var(--val) * 100%);
    background: linear-gradient(90deg, var(--accent-lo), var(--accent));
  }
  .thumb {
    position: absolute;
    left: calc(var(--val) * 100%);
    width: 12px;
    height: 16px;
    border-radius: 2px;
    background: linear-gradient(180deg, #3a3e48, #1a1c21);
    border: 1px solid #000;
    transform: translateX(-50%);
    pointer-events: none;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.12),
      0 1px 3px rgba(0, 0, 0, 0.8);
  }
  .thumb::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 3px;
    bottom: 3px;
    width: 1px;
    background: var(--fg-3);
    transform: translateX(-50%);
  }
</style>
