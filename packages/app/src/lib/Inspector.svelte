<script lang="ts">
  /**
   * Phase 7 M2 — right-side inspector pane. Empty in M2; M4 wires it
   * to the current selection (track / clip / audio region). The pane
   * is collapsible from a button on its header. When collapsed, the
   * grid column is 0px wide and the body is hidden.
   */
  import IconButton from './ui/IconButton.svelte';

  let {
    collapsed = $bindable(),
    width = 280,
  }: {
    collapsed: boolean;
    width?: number;
  } = $props();
</script>

{#if collapsed}
  <aside
    class="inspector inspector--collapsed"
    data-testid="inspector"
    aria-label="Inspector (collapsed)"
  >
    <IconButton
      ariaLabel="Show inspector"
      title="Show inspector (Cmd/Ctrl+\\)"
      testId="inspector-expand"
      onclick={() => (collapsed = false)}
    >‹</IconButton>
  </aside>
{:else}
  <aside
    class="inspector"
    style:width="{width}px"
    data-testid="inspector"
    aria-label="Inspector"
  >
    <header class="head">
      <span class="title">Inspector</span>
      <IconButton
        variant="ghost"
        ariaLabel="Hide inspector"
        title="Hide inspector (Cmd/Ctrl+\\)"
        testId="inspector-collapse"
        onclick={() => (collapsed = true)}
      >›</IconButton>
    </header>
    <div class="body" data-testid="inspector-body">
      <p class="empty">Select a track or clip to see details.</p>
    </div>
  </aside>
{/if}

<style>
  .inspector {
    background: var(--bg-2);
    border-left: 1px solid var(--line-1);
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .inspector--collapsed {
    width: 24px;
    align-items: center;
    justify-content: flex-start;
    padding-top: var(--sp-3);
  }
  .head {
    height: 32px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-3);
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
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
    padding: var(--sp-4);
    color: var(--fg-1);
  }
  .empty {
    margin: 0;
    color: var(--fg-3);
    font-size: var(--text-11);
    line-height: 1.6;
  }
</style>
