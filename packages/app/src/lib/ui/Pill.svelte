<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Compact toggle pill used for S/M/A/R controls on track + mixer
   * strips. Single letter inside; semantic color when active.
   */
  type Kind = 'solo' | 'mute' | 'arm' | 'rec' | 'neutral';

  let {
    kind = 'neutral',
    active = false,
    disabled = false,
    onclick,
    ariaLabel,
    testId,
    children,
  }: {
    kind?: Kind;
    active?: boolean;
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    ariaLabel: string;
    testId?: string;
    children?: Snippet;
  } = $props();
</script>

<button
  type="button"
  class="pill"
  class:active
  data-kind={kind}
  {disabled}
  aria-pressed={active}
  aria-label={ariaLabel}
  data-testid={testId}
  onclick={onclick}
>
  {#if children}{@render children()}{/if}
</button>

<style>
  .pill {
    width: 18px;
    height: 18px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line-2);
    background: var(--bg-2);
    color: var(--fg-2);
    font-family: var(--font-mono);
    font-size: var(--text-10);
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
  }
  .pill:hover { color: var(--fg-0); border-color: var(--fg-3); }
  .pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .pill:disabled { opacity: 0.4; cursor: not-allowed; }

  .pill.active[data-kind="solo"] {
    background: var(--solo);
    color: #1a1500;
    border-color: var(--solo);
  }
  .pill.active[data-kind="mute"] {
    background: var(--mute);
    color: var(--fg-0);
    border-color: var(--mute);
  }
  .pill.active[data-kind="arm"] {
    background: var(--arm);
    color: #1a0a00;
    border-color: var(--arm);
  }
  .pill.active[data-kind="rec"] {
    background: var(--rec);
    color: var(--accent-fg);
    border-color: var(--rec);
    box-shadow: 0 0 6px rgba(226, 52, 45, 0.5);
  }
  .pill.active[data-kind="neutral"] {
    background: var(--fg-2);
    color: var(--bg-0);
    border-color: var(--fg-2);
  }
</style>
