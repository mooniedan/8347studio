<script lang="ts">
  /**
   * Reason-style circular knob with subtle bevel + tick marks. Drag
   * vertically to change; Shift = fine. Visual is driven by `--val`
   * (0..1 normalized).
   */
  let {
    value = $bindable(),
    min = 0,
    max = 1,
    step = 0,
    size = 48,
    label,
    suffix = '',
    precision = 2,
    ariaLabel,
    testId,
    disabled = false,
  }: {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    size?: number;
    label?: string;
    suffix?: string;
    precision?: number;
    ariaLabel?: string;
    testId?: string;
    disabled?: boolean;
  } = $props();

  const norm = $derived((value - min) / (max - min));

  let dragOrigin: { y: number; start: number } | null = null;

  function clamp(n: number) { return Math.min(max, Math.max(min, n)); }
  function applyStep(n: number) {
    if (step > 0) return Math.round((n - min) / step) * step + min;
    return n;
  }
  function commit(n: number) {
    const next = clamp(applyStep(n));
    if (next !== value) value = next;
  }

  function onpointerdown(e: PointerEvent) {
    if (disabled) return;
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragOrigin = { y: e.clientY, start: value };
    e.preventDefault();
  }
  function onpointermove(e: PointerEvent) {
    if (!dragOrigin) return;
    const dy = dragOrigin.y - e.clientY;
    const range = max - min;
    const sensitivity = e.shiftKey ? 400 : 150; // px for full sweep
    commit(dragOrigin.start + (dy / sensitivity) * range);
  }
  function onpointerup(e: PointerEvent) {
    if (!dragOrigin) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragOrigin = null;
  }
  function onkeydown(e: KeyboardEvent) {
    if (disabled) return;
    const range = max - min;
    const s = step > 0 ? step : range / 100;
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      commit(value - s); e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      commit(value + s); e.preventDefault();
    }
  }
  function ondblclick() {
    if (disabled) return;
    // reset to midpoint as a reasonable default
    commit(min + (max - min) * 0.5);
  }

  const fmt = (n: number) =>
    precision > 0 ? n.toFixed(precision) : Math.round(n).toString();
</script>

<div class="knob-wrap" data-testid={testId}>
  <div
    class="knob"
    class:disabled
    style:--size="{size}px"
    style:--val={norm}
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-valuenow={value}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-label={ariaLabel ?? label}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    {onkeydown}
    {ondblclick}
  >
    <div class="ticks"></div>
    <div class="arc"></div>
    <div class="cap"></div>
  </div>
  {#if label}<span class="lbl">{label}</span>{/if}
  <span class="val">{fmt(value)}{suffix}</span>
</div>

<style>
  .knob-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .knob {
    width: var(--size);
    height: var(--size);
    position: relative;
    cursor: ns-resize;
    border-radius: 50%;
  }
  .knob.disabled { cursor: not-allowed; opacity: 0.45; }
  .knob:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }

  .ticks {
    position: absolute;
    inset: 0;
    border-radius: 50%;
  }
  .ticks::before {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    background: conic-gradient(from 225deg,
      var(--fg-3) 0 1deg, transparent 1deg 27deg,
      var(--fg-3) 27deg 28deg, transparent 28deg 54deg,
      var(--fg-3) 54deg 55deg, transparent 55deg 81deg,
      var(--fg-3) 81deg 82deg, transparent 82deg 108deg,
      var(--fg-3) 108deg 109deg, transparent 109deg 135deg,
      var(--fg-3) 135deg 136deg, transparent 136deg 162deg,
      var(--fg-3) 162deg 163deg, transparent 163deg 189deg,
      var(--fg-3) 189deg 190deg, transparent 190deg 216deg,
      var(--fg-3) 216deg 217deg, transparent 217deg 243deg,
      var(--fg-3) 243deg 244deg, transparent 244deg 270deg,
      var(--fg-3) 270deg 271deg, transparent 271deg 360deg);
    -webkit-mask: radial-gradient(circle, transparent 56%, black 57%, black 62%, transparent 63%);
            mask: radial-gradient(circle, transparent 56%, black 57%, black 62%, transparent 63%);
  }
  .arc {
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    background: conic-gradient(from 225deg,
      var(--accent) 0deg,
      var(--accent) calc(var(--val) * 270deg),
      #1d1f24 calc(var(--val) * 270deg),
      #1d1f24 270deg,
      transparent 270deg);
    -webkit-mask: radial-gradient(circle, transparent 64%, black 65%, black 78%, transparent 79%);
            mask: radial-gradient(circle, transparent 64%, black 65%, black 78%, transparent 79%);
    filter: drop-shadow(0 0 4px rgba(226, 52, 45, 0.35));
  }
  .cap {
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 30% 25%, rgba(255, 255, 255, 0.16), transparent 45%),
      linear-gradient(160deg, #2a2d35 0%, #16181c 60%, #0c0d10 100%);
    border: 1px solid #000;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.10),
      inset 0 -2px 4px rgba(0, 0, 0, 0.6),
      0 2px 4px rgba(0, 0, 0, 0.8);
  }
  .cap::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 8%;
    width: 2px;
    height: 30%;
    background: linear-gradient(180deg, var(--fg-0), var(--fg-2));
    transform: translateX(-50%) rotate(calc(-135deg + var(--val) * 270deg));
    transform-origin: 50% 145%;
    border-radius: 1px;
    box-shadow: 0 0 3px rgba(255, 255, 255, 0.4);
  }

  .lbl {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .val {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-0);
    font-variant-numeric: tabular-nums;
  }
</style>
