<script lang="ts">
  import { onDestroy } from 'svelte';
  import Sequencer from './lib/Sequencer.svelte';
  import { createProject, type Project } from './lib/project';

  // Hydrate the Y.Doc from IndexedDB before mounting the Sequencer.
  // Avoids the race where a fresh UI writes defaults that overwrite a
  // just-restored doc.
  let project = $state<Project | null>(null);

  const ready = createProject().then((p) => {
    project = p;
    exposeDebugHandle(p);
  });

  onDestroy(() => {
    project?.destroy();
  });

  function exposeDebugHandle(p: Project) {
    Object.defineProperty(window, '__project', {
      configurable: true,
      get() {
        const firstClipId = p.clipById.keys().next().value as string | undefined;
        const firstClip = firstClipId ? p.clipById.get(firstClipId) : null;
        return {
          trackCount: p.tracks.length,
          clipCount: p.clipById.size,
          firstClipKind: firstClip?.get('kind') ?? null,
        };
      },
    });
  }
</script>

{#await ready}
  <p class="loading">loading…</p>
{:then}
  {#if project}
    <Sequencer {project} />
  {/if}
{/await}

<style>
  .loading {
    font-family: system-ui, sans-serif;
    color: #888;
    padding: 16px;
  }
</style>
