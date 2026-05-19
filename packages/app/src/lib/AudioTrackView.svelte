<script lang="ts">
  import { untrack } from 'svelte';
  import {
    STEP_TICKS,
    STEPS_PER_CLIP,
    type Project,
    type AudioRegionView,
    type AssetMetadataView,
    getAudioRegions,
    getAssetMetadata,
  } from './project';
  import Waveform from './Waveform.svelte';

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

  /// Pixels-per-tick — matches the piano-roll grid (`--col-w: 36px`
  /// over `STEP_TICKS` ticks per cell), so an audio region rendered
  /// alongside a piano-roll clip lines up bar-for-bar.
  const PX_PER_TICK = 36 / STEP_TICKS;

  /// Default visible-timeline span: 4 bars × 16 steps = 64 steps.
  /// The actual timeline width also grows past this if any region
  /// extends beyond it, so dropped clips stay visible.
  const DEFAULT_STEPS = STEPS_PER_CLIP * 4;

  const totalTicks = $derived.by((): number => {
    let max = DEFAULT_STEPS * STEP_TICKS;
    for (const r of regions) {
      const end = r.startTick + r.lengthTicks;
      if (end > max) max = end;
    }
    return max;
  });

  const timelineWidthPx = $derived(totalTicks * PX_PER_TICK);
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
    <div class="timeline-wrap">
      <div
        class="timeline"
        style="width: {timelineWidthPx}px;"
        data-testid={`audio-timeline-${trackIdx}`}
      >
        {#each regions as r, i (`${r.assetHash}:${r.startTick}:${i}`)}
          {@const m = meta(r.assetHash)}
          {@const leftPx = r.startTick * PX_PER_TICK}
          {@const widthPx = Math.max(8, r.lengthTicks * PX_PER_TICK)}
          {@const fadeInPx = r.lengthSamples > 0
            ? (r.fadeInSamples / r.lengthSamples) * widthPx
            : 0}
          {@const fadeOutPx = r.lengthSamples > 0
            ? (r.fadeOutSamples / r.lengthSamples) * widthPx
            : 0}
          <div
            class="region"
            data-testid={`audio-region-${trackIdx}-${i}`}
            style="left: {leftPx}px; width: {widthPx}px;"
            title={m?.sourceFilename ?? r.assetHash}
          >
            <Waveform hash={r.assetHash} widthPx={widthPx} />
            {#if fadeInPx > 0}
              <!--
                Phase-10 M3b — fade-in corner overlay. The triangle
                masks the leading edge of the waveform; its hypotenuse
                represents the linear gain curve ramping from 0 to 1.
                The companion `.fade-curve` is a thin orange line that
                traces the same edge so the curve is legible even at
                short fade lengths.
              -->
              <div
                class="fade fade-in"
                data-testid={`audio-region-${trackIdx}-${i}-fade-in`}
                style="width: {fadeInPx}px;"
                aria-label="Fade in"
              ></div>
            {/if}
            {#if fadeOutPx > 0}
              <div
                class="fade fade-out"
                data-testid={`audio-region-${trackIdx}-${i}-fade-out`}
                style="width: {fadeOutPx}px;"
                aria-label="Fade out"
              ></div>
            {/if}
            <span class="region-label">
              <span class="hash">{shortHash(r.assetHash)}</span>
              {#if m}
                <span class="label">
                  {m.sourceFilename ?? 'asset'}
                  · {formatSamples(r.lengthSamples, m.sampleRate)}
                </span>
              {:else}
                <span class="label">· loading metadata…</span>
              {/if}
            </span>
            <span class="pos" data-testid={`audio-region-${trackIdx}-${i}-position`}>
              tick {r.startTick}
            </span>
          </div>
        {/each}
      </div>
    </div>
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
  .timeline-wrap {
    overflow-x: auto;
    background: #0e0f12;
    border: 1px solid #2a2a2a;
  }
  .timeline {
    position: relative;
    height: 72px;
    background-image:
      linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 576px 100%;
  }
  .region {
    position: absolute;
    top: 4px;
    bottom: 4px;
    background: #1d1f1a;
    border: 1px solid #3a4f2a;
    border-radius: 2px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* Phase-10 M3b — fade overlays.
     `clip-path: polygon(...)` carves a triangle out of the otherwise
     opaque dark mask: the unmasked portion is what the audio gain
     curve has *muted*. The fade-in's apex is at the leading edge;
     the fade-out's apex is at the trailing edge. The orange
     hairline traces the gain curve itself. */
  .fade {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.55);
  }
  .fade-in {
    left: 0;
    clip-path: polygon(0% 0%, 100% 0%, 0% 100%);
  }
  .fade-out {
    right: 0;
    clip-path: polygon(0% 0%, 100% 0%, 100% 100%);
  }
  .region-label {
    position: absolute;
    top: 2px;
    left: 4px;
    right: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    font-size: 9px;
    text-shadow: 0 1px 0 rgba(0,0,0,0.8);
  }
  .hash {
    font-family: ui-monospace, monospace;
    font-size: 9px;
    color: #88c060;
    background: rgba(10, 21, 5, 0.85);
    border: 1px solid #1f2f10;
    border-radius: 3px;
    padding: 1px 4px;
  }
  .label {
    color: #ddd;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pos {
    position: absolute;
    bottom: 2px;
    right: 4px;
    color: #888;
    font-variant-numeric: tabular-nums;
    font-size: 9px;
    pointer-events: none;
    text-shadow: 0 1px 0 rgba(0,0,0,0.8);
  }
</style>
