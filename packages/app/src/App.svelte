<script lang="ts">
  import { onDestroy } from 'svelte';
  import Sequencer from './lib/Sequencer.svelte';
  import { createProject, type Project } from './lib/project';
  import * as audio from './lib/audio';
  import { attachBridge, type Bridge } from './lib/engine-bridge';

  // Hydrate the Y.Doc from IndexedDB before mounting the Sequencer.
  // Avoids the race where a fresh UI writes defaults that overwrite a
  // just-restored doc.
  let project = $state<Project | null>(null);
  let bridge = $state<Bridge | null>(null);

  const ready = createProject().then(async (p) => {
    project = p;
    exposeDebugHandle(p);
    // Attach the engine bridge eagerly so SAB writes (gain etc.) queue
    // even before the user clicks play; the worklet drains them once
    // the audio thread starts.
    const { ring } = await audio.ensureReady();
    bridge = attachBridge(p, { ring, postRebuild: audio.postRebuild });
    exposeBridgeHandle(bridge);
  });

  onDestroy(() => {
    bridge?.destroy();
    project?.destroy();
  });

  function exposeDebugHandle(p: Project) {
    Object.defineProperty(window, '__project', {
      configurable: true,
      get() {
        const firstClipId = p.clipById.keys().next().value as string | undefined;
        const firstClip = firstClipId ? p.clipById.get(firstClipId) : null;
        const trackId = p.tracks.length > 0 ? p.tracks.get(0) : null;
        const track = trackId ? p.trackById.get(trackId) : null;
        return {
          trackCount: p.tracks.length,
          clipCount: p.clipById.size,
          firstClipKind: firstClip?.get('kind') ?? null,
          firstTrackGain: track?.get('gain') ?? null,
        };
      },
    });
  }

  function exposeBridgeHandle(b: Bridge) {
    Object.defineProperty(window, '__bridge', {
      configurable: true,
      get() {
        return {
          rebuild: () => b.rebuild(),
          setTransport: (play: boolean) => b.setTransport(play),
          debugTrackGain: (track: number) => audio.debugRead('trackGain', track),
          debugTrackCount: () => audio.debugRead('trackCount'),
          debugMasterGain: () => audio.debugRead('masterGain'),
          debugCurrentTick: () => audio.debugRead('currentTick'),
          debugBpm: () => audio.debugRead('bpm'),
        };
      },
    });
  }
</script>

{#await ready}
  <p class="loading">loading…</p>
{:then}
  {#if project && bridge}
    <Sequencer {project} {bridge} />
  {/if}
{/await}

<style>
  .loading {
    font-family: system-ui, sans-serif;
    color: #888;
    padding: 16px;
  }
</style>
