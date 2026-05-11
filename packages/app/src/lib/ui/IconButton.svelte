<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    variant = 'default',
    disabled = false,
    onclick,
    ariaLabel,
    title,
    testId,
    children,
  }: {
    variant?: 'default' | 'ghost';
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    ariaLabel: string;
    title?: string;
    testId?: string;
    children?: Snippet;
  } = $props();
</script>

<button
  type="button"
  class="btn btn--icon"
  class:btn--ghost={variant === 'ghost'}
  {disabled}
  aria-label={ariaLabel}
  {title}
  data-testid={testId}
  onclick={onclick}
>
  {#if children}{@render children()}{/if}
</button>

<style>
  .btn {
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-2);
    background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
    color: var(--fg-1);
    cursor: pointer;
    box-shadow: var(--shadow-rim);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .btn:hover {
    color: var(--fg-0);
    background: linear-gradient(180deg, #2c303a, var(--bg-3));
  }
  .btn:active {
    box-shadow: var(--shadow-inset);
    transform: translateY(0.5px);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }

  .btn--ghost {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }
  .btn--ghost:hover {
    background: var(--bg-2);
    color: var(--fg-0);
  }
</style>
