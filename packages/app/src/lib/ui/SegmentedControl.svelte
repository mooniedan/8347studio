<script lang="ts" generics="T extends string">
  interface Option {
    value: T;
    label: string;
    title?: string;
  }

  let {
    options,
    value = $bindable(),
    ariaLabel,
    testId,
    disabled = false,
  }: {
    options: Option[];
    value: T;
    ariaLabel?: string;
    testId?: string;
    disabled?: boolean;
  } = $props();
</script>

<div
  class="seg"
  role="radiogroup"
  aria-label={ariaLabel}
  data-testid={testId}
>
  {#each options as opt (opt.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      class:on={value === opt.value}
      title={opt.title}
      {disabled}
      data-testid={testId ? `${testId}-${opt.value}` : undefined}
      onclick={() => (value = opt.value)}
    >{opt.label}</button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    background: var(--bg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: 2px;
    box-shadow: var(--shadow-inset);
  }
  .seg button {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    background: transparent;
    border: none;
    color: var(--fg-2);
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 1px;
    letter-spacing: 0.04em;
    height: 22px;
    line-height: 1;
  }
  .seg button:hover { color: var(--fg-0); }
  .seg button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .seg button:disabled { opacity: 0.45; cursor: not-allowed; }
  .seg button.on {
    background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
    color: var(--fg-0);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.06),
      0 1px 0 rgba(0, 0, 0, 0.5);
  }
</style>
