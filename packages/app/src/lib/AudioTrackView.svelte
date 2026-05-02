<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    type Project,
    type AudioRegionView,
    type AssetMetadataView,
    getAudioRegions,
    getAssetMetadata,
  } from './project';

  const {
    project,
    trackIdx,
    recording = false,
    onToggleRecord = () => {},
  }: {
    project: Project;
    trackIdx: number;
    recording?: boolean;
    onToggleRecord?: () => void;
  } = $props();

  let regions = $state<AudioRegionView[]>(untrack(() => getAudioRegions(project, trackIdx)));

  function refresh() {
    regions = getAudioRegions(project, trackIdx);
  }

  $effect(() => {
    void trackIdx;
    refresh();
    project.trackById.observeDeep(refresh);
    project.tracks.observe(refresh);
    project.assets.observe(refresh);
    return () => {
      project.trackById.unobserveDeep(refresh);
      project.tracks.unobserve(refresh);
      project.assets.unobserve(refresh);
    };
  });

  function meta(hash: string): AssetMetadataView | null {
    return getAssetMetadata(project, hash);
  }

  function shortHash(hash: string): string {
    return hash.slice(0, 8);
  }

  function formatSamples(samples: number, sampleRate: number): string {
    const seconds = samples / sampleRate;
    if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
    return `${seconds.toFixed(2)} s`;
  }
</script>

<section class="audio-track" data-testid={`audio-track-${trackIdx}`}>
  <header class="head">
    <span class="title">Audio Track</span>
    <button
      class="record"
      class:recording
      data-testid={`audio-track-${trackIdx}-record`}
      onclick={() => onToggleRecord()}
      aria-pressed={recording}
      title="Record from the default microphone (getUserMedia)"
    >
      <span class="record-dot"></span>
      {recording ? 'Stop' : 'Record'}
    </button>
    <span class="hint">Drag a WAV / MP3 file in to import, or hit Record.</span>
  </header>
  {#if regions.length === 0}
    <div class="empty" data-testid={`audio-track-${trackIdx}-empty`}>No regions yet.</div>
  {:else}
    <ol class="regions">
      {#each regions as r, i (i)}
        {@const m = meta(r.assetHash)}
        <li class="region" data-testid={`audio-region-${trackIdx}-${i}`}>
          <span class="hash">{shortHash(r.assetHash)}</span>
          <span class="label">
            {m?.sourceFilename ?? 'asset'}
            {#if m}
              · {m.channels} ch · {m.sampleRate} Hz · {formatSamples(r.lengthSamples, m.sampleRate)}
            {:else}
              · loading metadata…
            {/if}
          </span>
          <span class="pos" data-testid={`audio-region-${trackIdx}-${i}-position`}>
            tick {r.startTick}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .audio-track {
    background: #131313;
    border: 1px solid #2a2a2a;
    color: #ccc;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    padding: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .title {
    font-weight: 600;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 10px;
  }
  .hint {
    color: #666;
    font-size: 10px;
  }
  .record {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 3px 8px;
    font: 11px system-ui, sans-serif;
    cursor: pointer;
  }
  .record:hover {
    background: #232323;
  }
  .record .record-dot {
    width: 8px;
    height: 8px;
    background: #555;
    border-radius: 50%;
  }
  .record.recording {
    border-color: #ff3a3a;
    color: #ff8585;
    background: #2a0e0e;
  }
  .record.recording .record-dot {
    background: #ff3a3a;
    animation: rec-pulse 1s infinite;
  }
  @keyframes rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .empty {
    color: #666;
    font-style: italic;
    font-size: 10px;
    border: 1px dashed #2a2a2a;
    padding: 16px;
    text-align: center;
  }
  ol {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .region {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: center;
    background: #1d1f1a;
    border: 1px solid #3a4f2a;
    padding: 6px 8px;
  }
  .hash {
    font-family: ui-monospace, monospace;
    font-size: 9px;
    color: #88c060;
    background: #0a1505;
    border: 1px solid #1f2f10;
    border-radius: 3px;
    padding: 1px 4px;
  }
  .label {
    color: #ddd;
  }
  .pos {
    color: #888;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
  }
</style>
