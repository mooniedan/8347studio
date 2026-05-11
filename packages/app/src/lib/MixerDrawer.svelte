<script lang="ts">
  /**
   * Phase 7 M2 — bottom mixer drawer. Wraps the existing Mixer; when
   * collapsed shows a 32px summary strip (click to expand). The
   * expanded height comes from layout prefs.
   */
  import type { Snippet } from 'svelte';
  import IconButton from './ui/IconButton.svelte';

  let {
    expanded = $bindable(),
    height = 320,
    children,
  }: {
    expanded: boolean;
    height?: number;
    children: Snippet;
  } = $props();
</script>

<section
  class="drawer"
  class:drawer--expanded={expanded}
  style:--drawer-h="{height}px"
  data-testid="mixer-drawer"
  aria-label="Mixer drawer"
  data-expanded={expanded}
>
  <header class="head">
    <span class="title">Mixer</span>
    <IconButton
      variant="ghost"
      ariaLabel={expanded ? 'Collapse mixer' : 'Expand mixer'}
      title={expanded ? 'Collapse mixer (Cmd/Ctrl+M)' : 'Expand mixer (Cmd/Ctrl+M)'}
      testId="drawer-toggle"
      onclick={() => (expanded = !expanded)}
    >{expanded ? '▾' : '▴'}</IconButton>
  </header>
  {#if expanded}
    <div class="body" data-testid="drawer-body">{@render children()}</div>
  {/if}
</section>

<style>
  .drawer {
    background: var(--bg-2);
    border-top: 1px solid var(--line-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* collapsed height = head only */
    height: 32px;
  }
  .drawer--expanded {
    height: var(--drawer-h);
  }
  .head {
    height: 32px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-4);
    background: var(--bg-1);
    border-bottom: 1px solid var(--line-0);
  }
  .head .title {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .body {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
</style>
