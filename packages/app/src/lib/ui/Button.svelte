<script lang="ts">
  import type { Snippet } from 'svelte';

  type Variant = 'default' | 'primary' | 'ghost';

  let {
    variant = 'default',
    disabled = false,
    type = 'button',
    onclick,
    children,
    ariaLabel,
    title,
    testId,
  }: {
    variant?: Variant;
    disabled?: boolean;
    type?: 'button' | 'submit';
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
    ariaLabel?: string;
    title?: string;
    testId?: string;
  } = $props();
</script>

<button
  {type}
  class="btn"
  class:btn--primary={variant === 'primary'}
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
    font-family: var(--font-sans);
    font-size: var(--text-12);
    font-weight: 500;
    letter-spacing: 0.01em;
    padding: 6px 12px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-2);
    background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
    color: var(--fg-0);
    cursor: pointer;
    box-shadow: var(--shadow-rim);
    display: inline-flex;
    align-items: center;
    gap: var(--sp-3);
    height: 26px;
    line-height: 1;
  }
  .btn:hover {
    background: linear-gradient(180deg, #2a2e36, var(--bg-3));
  }
  .btn:active {
    box-shadow: var(--shadow-inset);
    transform: translateY(0.5px);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn--primary {
    background: linear-gradient(180deg, var(--accent-hi), var(--accent), var(--accent-lo));
    border-color: var(--accent-lo);
    color: var(--accent-fg);
    text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      inset 0 -1px 0 rgba(0, 0, 0, 0.4),
      0 1px 0 rgba(0, 0, 0, 0.6);
  }
  .btn--primary:hover { filter: brightness(1.08); }

  .btn--ghost {
    background: transparent;
    border-color: transparent;
    color: var(--fg-1);
    box-shadow: none;
  }
  .btn--ghost:hover {
    background: var(--bg-2);
    color: var(--fg-0);
  }
</style>
