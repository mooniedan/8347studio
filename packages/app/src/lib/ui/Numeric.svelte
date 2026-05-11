<script lang="ts">
  /**
   * Mono-numeric value display + edit. Click-and-drag (vertical) to
   * change; type to override; wheel to nudge. The drag step is the
   * default sensitivity; Shift = `step * 0.1`. Values are clamped to
   * `[min, max]` and rounded to `precision` decimal places.
   */
  let {
    value = $bindable(),
    min = -Infinity,
    max = Infinity,
    step = 1,
    precision = 0,
    suffix = '',
    width = 56,
    ariaLabel,
    testId,
    disabled = false,
  }: {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    precision?: number;
    suffix?: string;
    width?: number;
    ariaLabel?: string;
    testId?: string;
    disabled?: boolean;
  } = $props();

  let editing = $state(false);
  let buffer = $state('');
  let dragOrigin: { y: number; start: number; shift: boolean } | null = null;

  const fmt = (n: number) =>
    precision > 0 ? n.toFixed(precision) : Math.round(n).toString();

  function clamp(n: number) {
    return Math.min(max, Math.max(min, n));
  }

  function commit(n: number) {
    const next = clamp(
      precision > 0
        ? Math.round(n * 10 ** precision) / 10 ** precision
        : Math.round(n),
    );
    if (next !== value) value = next;
  }

  function onpointerdown(e: PointerEvent) {
    if (disabled || editing) return;
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragOrigin = { y: e.clientY, start: value, shift: e.shiftKey };
    e.preventDefault();
  }
  function onpointermove(e: PointerEvent) {
    if (!dragOrigin) return;
    const dy = dragOrigin.y - e.clientY;
    const s = (e.shiftKey ? step * 0.1 : step);
    commit(dragOrigin.start + dy * s);
  }
  function onpointerup(e: PointerEvent) {
    if (!dragOrigin) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragOrigin = null;
  }
  function onwheel(e: WheelEvent) {
    if (disabled || editing) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const s = e.shiftKey ? step * 0.1 : step;
    commit(value + dir * s);
  }
  function ondblclick() {
    if (disabled) return;
    buffer = fmt(value);
    editing = true;
  }
  function commitBuffer() {
    const n = parseFloat(buffer);
    if (!Number.isNaN(n)) commit(n);
    editing = false;
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') commitBuffer();
    else if (e.key === 'Escape') editing = false;
  }
</script>

{#if editing}
  <!-- svelte-ignore a11y_autofocus — focus is user-initiated via dblclick -->
  <input
    type="text"
    class="num-input"
    style:width="{width}px"
    inputmode="decimal"
    bind:value={buffer}
    onblur={commitBuffer}
    {onkeydown}
    autofocus
    aria-label={ariaLabel}
    data-testid={testId}
  />
{:else}
  <span
    class="num"
    class:disabled
    style:width="{width}px"
    tabindex={disabled ? -1 : 0}
    role="spinbutton"
    aria-valuenow={value}
    aria-valuemin={min === -Infinity ? undefined : min}
    aria-valuemax={max === Infinity ? undefined : max}
    aria-label={ariaLabel}
    data-testid={testId}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    {onwheel}
    {ondblclick}
  >{fmt(value)}{#if suffix}<span class="suffix">{suffix}</span>{/if}</span>
{/if}

<style>
  .num {
    display: inline-flex;
    align-items: baseline;
    justify-content: center;
    gap: 2px;
    font-family: var(--font-mono);
    font-size: var(--text-12);
    font-variant-numeric: tabular-nums;
    color: var(--fg-0);
    background: var(--bg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: 2px 6px;
    cursor: ns-resize;
    user-select: none;
    box-shadow: var(--shadow-inset);
    height: 22px;
    line-height: 1;
  }
  .num:hover { border-color: var(--line-2); }
  .num:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .num.disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
  .num .suffix {
    color: var(--fg-2);
    font-size: var(--text-10);
  }

  .num-input {
    font-family: var(--font-mono);
    font-size: var(--text-12);
    color: var(--fg-0);
    background: var(--bg-0);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    padding: 2px 6px;
    height: 22px;
    text-align: center;
    outline: none;
    box-shadow: var(--shadow-inset);
  }
</style>
