<script lang="ts">
  /**
   * Phase 8 M8 — descriptor-aware param control.
   *
   * Reads a `ParamDescriptor` + current value and renders the most
   * fitting Phase-7 base component: SegmentedControl for short enum
   * lists, Knob for continuous params (frequency-like get exp-curve
   * visual mapping), Slider for everything else.
   *
   * MIDI Learn affordances ride along: when `learnActive` is true a
   * small target dot appears next to the value readout; an existing
   * bound CC is shown as a chip the user can click to unbind.
   *
   * The component is value-bound — the parent owns the canonical
   * value and reacts to changes by calling `onChange(value)`. Inside
   * we run a local proxy through the base components' `bind:value`,
   * syncing the proxy down from `value` and firing `onChange` when
   * the proxy moves up.
   */
  import { type ParamDescriptor } from '../plugin-descriptors';
  import Knob from './Knob.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import Slider from './Slider.svelte';

  let {
    descriptor,
    value,
    boundCC,
    learnActive = false,
    onChange,
    onLearnClick,
    onUnbindCC,
  }: {
    descriptor: ParamDescriptor;
    value: number;
    boundCC?: number;
    learnActive?: boolean;
    onChange: (value: number) => void;
    onLearnClick?: (paramId: number) => void;
    onUnbindCC?: (cc: number) => void;
  } = $props();

  // Component pick — short enum lists are easier to scan as segments;
  // longer enums + every continuous param falls back to slider, with
  // exp-curve / frequency params getting a Knob for the synth feel.
  const isEnum = $derived((descriptor.options?.length ?? 0) > 0);
  const isShortEnum = $derived(isEnum && (descriptor.options?.length ?? 0) <= 4);
  const useKnob = $derived(
    !isEnum &&
      (descriptor.curve === 'exp' ||
        descriptor.unit === 'hz' ||
        descriptor.unit === 'cents' ||
        descriptor.name.toLowerCase().includes('cutoff')),
  );

  function format(v: number): string {
    if (descriptor.options) return descriptor.options[Math.round(v)] ?? String(v);
    if (descriptor.unit === 'hz') {
      return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`;
    }
    if (descriptor.unit === 'seconds') {
      return v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`;
    }
    if (descriptor.unit === 'cents') return `${v.toFixed(0)} ¢`;
    if (descriptor.unit === 'db') return `${v.toFixed(1)} dB`;
    if (descriptor.unit === 'percent') return `${(v * 100).toFixed(0)}%`;
    if (descriptor.unit === 'semitones') return `${v.toFixed(0)} st`;
    return Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(2);
  }

  // For exp-curve params we route the Knob through a 0..1 proxy
  // and convert back on commit so the knob rotation matches an
  // exponential frequency feel (1 kHz sits in the middle of a
  // 20 Hz..20 kHz sweep).
  function valueToExpProxy(v: number): number {
    const span = descriptor.max / descriptor.min;
    return Math.log(v / descriptor.min) / Math.log(span);
  }
  function expProxyToValue(pos: number): number {
    const span = descriptor.max / descriptor.min;
    return descriptor.min * Math.pow(span, pos);
  }
  const useExpKnob = $derived(
    useKnob && descriptor.curve === 'exp' && descriptor.min > 0,
  );

  // Local proxies for the base components' bind:value. We always
  // re-sync from the prop via an effect rather than initializing
  // from it, which keeps the data flow one-way (prop → proxy →
  // control → onChange → prop) and avoids the stale-capture trap.
  // svelte-ignore state_referenced_locally — initial capture is
  // immediately overwritten by the first sync effect below.
  let knobValue = $state(value);
  let knobExpPos = $state(0);
  // svelte-ignore state_referenced_locally
  let sliderValue = $state(value);
  // svelte-ignore state_referenced_locally
  let segValue = $state(String(Math.round(value)));

  $effect(() => {
    knobValue = value;
    sliderValue = value;
    segValue = String(Math.round(value));
    knobExpPos = useExpKnob ? valueToExpProxy(value) : 0;
  });

  $effect(() => {
    if (useExpKnob) return; // exp uses knobExpPos
    if (useKnob && knobValue !== value) onChange(knobValue);
  });
  $effect(() => {
    if (!useExpKnob) return;
    const v = expProxyToValue(knobExpPos);
    if (Math.abs(v - value) > 1e-6) onChange(v);
  });
  $effect(() => {
    if (useKnob || isEnum) return;
    if (sliderValue !== value) onChange(sliderValue);
  });
  $effect(() => {
    if (!isShortEnum) return;
    const numeric = Number(segValue);
    if (Number.isFinite(numeric) && numeric !== Math.round(value)) onChange(numeric);
  });
  $effect(() => {
    if (!isEnum || isShortEnum) return;
    if (sliderValue !== value) onChange(sliderValue);
  });

  const segOptions = $derived(
    isShortEnum
      ? (descriptor.options ?? []).map((label, i) => ({
          value: String(i),
          label,
        }))
      : [],
  );
</script>

<div class="param" data-testid="param-{descriptor.id}">
  <div class="lbl">
    <span class="name">{descriptor.name}</span>
    <span class="val mono" data-testid="param-{descriptor.id}-value">{format(value)}</span>
  </div>

  <div class="ctrl">
    {#if isShortEnum}
      <SegmentedControl
        bind:value={segValue}
        options={segOptions}
        ariaLabel={descriptor.name}
        testId="param-{descriptor.id}-input"
      />
    {:else if useExpKnob}
      <Knob
        bind:value={knobExpPos}
        min={0}
        max={1}
        size={44}
        ariaLabel={descriptor.name}
        testId="param-{descriptor.id}-input"
      />
    {:else if useKnob}
      <Knob
        bind:value={knobValue}
        min={descriptor.min}
        max={descriptor.max}
        size={44}
        ariaLabel={descriptor.name}
        testId="param-{descriptor.id}-input"
      />
    {:else}
      <Slider
        bind:value={sliderValue}
        min={descriptor.min}
        max={descriptor.max}
        step={isEnum ? 1 : 0}
        ariaLabel={descriptor.name}
        testId="param-{descriptor.id}-input"
      />
    {/if}

    <div class="midi">
      {#if boundCC != null}
        <button
          type="button"
          class="cc-chip"
          onclick={() => onUnbindCC?.(boundCC!)}
          data-testid="param-{descriptor.id}-cc"
          title="Click to unbind"
        >CC{boundCC} ✕</button>
      {/if}
      {#if learnActive}
        <button
          type="button"
          class="learn-target"
          onclick={() => onLearnClick?.(descriptor.id)}
          data-testid="param-{descriptor.id}-learn"
          aria-label="Bind hardware CC to {descriptor.name}"
        ></button>
      {/if}
    </div>
  </div>
</div>

<style>
  .param {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-width: 0;
  }
  .lbl {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .lbl .val {
    color: var(--fg-0);
    text-transform: none;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  .ctrl {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 28px;
  }
  .ctrl > :global(*:first-child) {
    flex: 1;
    min-width: 0;
  }
  .midi {
    display: flex;
    gap: 2px;
    align-items: center;
    flex-shrink: 0;
  }
  .cc-chip {
    background: var(--accent-tint);
    color: var(--accent-hi);
    border: 1px solid var(--accent-lo);
    border-radius: 8px;
    padding: 0 6px;
    font-family: var(--font-mono);
    font-size: var(--text-10);
    cursor: pointer;
    height: 16px;
    line-height: 1;
  }
  .cc-chip:hover { background: rgba(226, 52, 45, 0.2); }
  .learn-target {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid #4ad6ff;
    background: transparent;
    cursor: pointer;
    padding: 0;
    animation: pulse 1.2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
</style>
