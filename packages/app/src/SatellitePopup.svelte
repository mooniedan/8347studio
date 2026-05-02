<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import * as Y from 'yjs';
  import Mixer from './lib/Mixer.svelte';
  import { projectFromDoc, type Project } from './lib/project';
  import { attachSatelliteSync, type SatelliteHandle } from './lib/satellite';

  const { panel }: { panel: string } = $props();

  let project = $state<Project | null>(null);
  let satellite: SatelliteHandle | null = null;
  // We don't render the panel until the first snapshot arrives so
  // the UI doesn't flash an empty project. 200 ms is the channel
  // round-trip in practice; if the root doesn't reply (no root open)
  // we fall back to rendering the (empty) replica anyway.
  let ready = $state(false);

  onMount(() => {
    // Apply popup-window body reset at runtime — keeps the SVG-styled
    // global rules out of the main app's CSS bundle (Phase-6 M3
    // taught us :global leaks even when the component never mounts
    // in the main window).
    document.body.style.margin = '0';
    document.body.style.background = '#0d0d0d';
    document.body.style.color = '#ddd';
    document.body.style.fontFamily = 'system-ui, sans-serif';

    const doc = new Y.Doc();
    satellite = attachSatelliteSync(doc);
    project = projectFromDoc(doc, () => satellite?.destroy());
    // Resolve "ready" on either the first incoming update or after a
    // short timeout. Yjs fires the update event when applyUpdate is
    // called with the snapshot bytes from root.
    let resolved = false;
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== 'satellite-remote') return;
      if (resolved) return;
      resolved = true;
      ready = true;
    };
    doc.on('update', onUpdate);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ready = true;
      }
    }, 200);
  });

  onDestroy(() => {
    project?.destroy();
    satellite?.destroy();
  });
</script>

<div class="popup">
  <header class="head">
    <h1>{panel.replace(/^./, (c) => c.toUpperCase())} (popup)</h1>
    <button class="close" onclick={() => window.close()}>Close</button>
  </header>
  {#if ready && project}
    {#if panel === 'mixer'}
      <Mixer {project} audioEnabled={false} />
    {:else}
      <div class="unknown">Unknown panel: {panel}</div>
    {/if}
  {:else}
    <div class="loading">Syncing with root window…</div>
  {/if}
</div>

<style>
  .popup {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid #2a2a2a;
  }
  h1 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    flex: 1;
  }
  .close {
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 12px;
    font: 11px system-ui, sans-serif;
    cursor: pointer;
  }
  .loading,
  .unknown {
    padding: 24px;
    color: #888;
    font-size: 12px;
  }
</style>
