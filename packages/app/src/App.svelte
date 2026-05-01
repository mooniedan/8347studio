<script lang="ts">
  import { onDestroy } from 'svelte';
  import Sequencer from './lib/Sequencer.svelte';
  import TrackList from './lib/TrackList.svelte';
  import Mixer from './lib/Mixer.svelte';
  import PluginPanel from './lib/PluginPanel.svelte';
  import {
    createProject,
    addSubtractiveTrack,
    getTrackPluginId,
    type Project,
  } from './lib/project';
  import * as audio from './lib/audio';
  import { attachBridge, type Bridge } from './lib/engine-bridge';

  // Hydrate the Y.Doc from IndexedDB before mounting the Sequencer.
  // Avoids the race where a fresh UI writes defaults that overwrite a
  // just-restored doc.
  let project = $state<Project | null>(null);
  let bridge = $state<Bridge | null>(null);
  let selectedTrackIdx = $state(0);
  // Tracks the selected track's plugin id so the panel re-mounts on
  // synth-track switch and disappears for non-synth tracks.
  let selectedPluginId = $derived.by(() => {
    if (!project) return null;
    return getTrackPluginId(project, selectedTrackIdx);
  });

  const ready = createProject().then(async (p) => {
    project = p;
    exposeDebugHandle(p);
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
          debugTrackPeak: (track: number) => audio.debugRead('trackPeak', track),
          debugTrackParam: (track: number, paramId: number) =>
            audio.debugTrackParam(track, paramId),
          setParam: (track: number, paramId: number, value: number) =>
            b.setParam(track, paramId, value),
          addSubtractiveTrack: () => {
            if (!project) return -1;
            addSubtractiveTrack(project);
            return project.tracks.length - 1;
          },
        };
      },
    });
  }
</script>

{#await ready}
  <p class="loading">loading…</p>
{:then}
  {#if project && bridge}
    <h1>8347 Studio</h1>
    <div class="toolbar">
      <button
        class="add-synth"
        data-testid="add-synth-track"
        onclick={() => {
          if (!project) return;
          addSubtractiveTrack(project);
          selectedTrackIdx = project.tracks.length - 1;
        }}
      >+ Synth</button>
    </div>
    <div class="layout">
      <TrackList
        {project}
        selectedIdx={selectedTrackIdx}
        onSelect={(i) => (selectedTrackIdx = i)}
      />
      {#if selectedPluginId === 'builtin:subtractive'}
        <PluginPanel {project} trackIdx={selectedTrackIdx} />
      {:else}
        <Sequencer {project} {bridge} trackIdx={selectedTrackIdx} />
      {/if}
    </div>
    <Mixer {project} />
  {/if}
{/await}

<style>
  :global(body) {
    background: #0d0d0d;
    color: #ddd;
    margin: 0;
  }
  h1 {
    font-family: system-ui, sans-serif;
    font-size: 14px;
    font-weight: 600;
    color: #ccc;
    padding: 8px 16px;
    margin: 0;
    border-bottom: 1px solid #2a2a2a;
  }
  .layout {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 16px;
    padding: 16px;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid #1f1f1f;
  }
  .add-synth {
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 10px;
    font: 11px system-ui, sans-serif;
    cursor: pointer;
  }
  .add-synth:hover {
    background: #232323;
  }
  .loading {
    font-family: system-ui, sans-serif;
    color: #888;
    padding: 16px;
  }
</style>
