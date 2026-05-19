<script lang="ts">
  import { untrack } from 'svelte';
  import {
    STEP_TICKS,
    STEPS_PER_CLIP,
    type Project,
    type AudioRegionView,
    type AssetMetadataView,
    type AudioRegionPatch,
    getAudioRegions,
    getAssetMetadata,
    setAudioRegionFade,
    setAudioRegionGain,
    updateAudioRegion,
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

  /// Phase-10 M3c — drag-to-move + trim handles.
  ///
  /// Three drag kinds:
  ///   - `move`   — drag the region body to shift `startTick`.
  ///   - `trim-l` — left-edge handle: increases startTick, decreases
  ///     lengthTicks (and adjusts assetOffsetSamples so the right
  ///     edge stays glued to the same audio frame).
  ///   - `trim-r` — right-edge handle: adjusts lengthTicks only.
  ///
  /// During a drag the dragged region is rendered at the *preview*
  /// position computed live from the pointer delta; on release we
  /// flush a single `updateAudioRegion` transaction so collab peers
  /// see one commit, not a flurry of frame-by-frame updates.
  ///
  /// Drags snap to STEP_TICKS (1/16 step) so regions align with the
  /// grid by default. Holding shift would disable snap — deferred to
  /// a later slice.
  type RegionDragKind = 'move' | 'trim-l' | 'trim-r';
  interface RegionDrag {
    kind: RegionDragKind;
    regionIdx: number;
    startX: number;
    origStartTick: number;
    origLengthTicks: number;
    origStartSample: number;
    origLengthSamples: number;
    origAssetOffset: number;
    /// `lengthSamples / lengthTicks` snapshotted at pointerdown; we
    /// keep the ratio constant so timeline edits stay in lockstep
    /// with sample-domain edits. (When `lengthTicks` was 0 we fall
    /// back to 1 so divisions don't NaN.)
    samplesPerTick: number;
    previewStartTick: number;
    previewLengthTicks: number;
  }
  let regionDrag = $state<RegionDrag | null>(null);

  /// Phase-10 M3d — region selection drives the edit panel below the
  /// timeline. Selection is purely view-side; a no-movement pointer
  /// gesture on the region body sets it, while clicking the empty
  /// timeline (or any cell) below clears it. Clears automatically
  /// when the track changes or the selected index falls off the end
  /// of the regions array.
  let selectedRegionIdx = $state<number | null>(null);
  $effect(() => {
    void trackIdx;
    selectedRegionIdx = null;
  });
  $effect(() => {
    if (selectedRegionIdx != null && selectedRegionIdx >= regions.length) {
      selectedRegionIdx = null;
    }
  });

  function snapTicks(dxTicks: number): number {
    return Math.round(dxTicks / STEP_TICKS) * STEP_TICKS;
  }

  function startRegionDrag(
    e: PointerEvent,
    regionIdx: number,
    kind: RegionDragKind,
  ): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const r = regions[regionIdx];
    if (!r) return;
    const target = e.currentTarget as HTMLElement;
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const samplesPerTick = r.lengthTicks > 0 ? r.lengthSamples / r.lengthTicks : 1;
    regionDrag = {
      kind,
      regionIdx,
      startX: e.clientX,
      origStartTick: r.startTick,
      origLengthTicks: r.lengthTicks,
      origStartSample: r.startSample,
      origLengthSamples: r.lengthSamples,
      origAssetOffset: r.assetOffsetSamples,
      samplesPerTick,
      previewStartTick: r.startTick,
      previewLengthTicks: r.lengthTicks,
    };
  }

  function onTimelinePointerMove(e: PointerEvent) {
    const d = regionDrag;
    if (!d) return;
    const dxPx = e.clientX - d.startX;
    const dxTicks = snapTicks(dxPx / PX_PER_TICK);
    if (d.kind === 'move') {
      const newStart = Math.max(0, d.origStartTick + dxTicks);
      regionDrag = { ...d, previewStartTick: newStart, previewLengthTicks: d.origLengthTicks };
      return;
    }
    if (d.kind === 'trim-r') {
      const newLen = Math.max(STEP_TICKS, d.origLengthTicks + dxTicks);
      regionDrag = { ...d, previewStartTick: d.origStartTick, previewLengthTicks: newLen };
      return;
    }
    // trim-l: shift startTick up by appliedDx, decrease length by
    // appliedDx. Clamp so startTick stays >= 0 and length >= 1 step.
    let appliedDx = dxTicks;
    if (d.origStartTick + appliedDx < 0) appliedDx = -d.origStartTick;
    if (d.origLengthTicks - appliedDx < STEP_TICKS) {
      appliedDx = d.origLengthTicks - STEP_TICKS;
    }
    regionDrag = {
      ...d,
      previewStartTick: d.origStartTick + appliedDx,
      previewLengthTicks: d.origLengthTicks - appliedDx,
    };
  }

  function onTimelinePointerUp(e: PointerEvent) {
    const d = regionDrag;
    if (!d) return;
    regionDrag = null;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
    commitRegionDrag(d);
  }

  function commitRegionDrag(d: RegionDrag): void {
    const dStartTick = d.previewStartTick - d.origStartTick;
    const dLengthTicks = d.previewLengthTicks - d.origLengthTicks;
    if (dStartTick === 0 && dLengthTicks === 0) {
      // No-movement pointer-up on the region body acts as a tap-to-
      // select; trim-l / trim-r without movement is just a tap on
      // the grip and shouldn't change selection.
      if (d.kind === 'move') selectedRegionIdx = d.regionIdx;
      return;
    }
    const patch: AudioRegionPatch = {
      startTick: d.previewStartTick,
      lengthTicks: d.previewLengthTicks,
    };
    if (d.kind === 'move' && dStartTick !== 0) {
      // Body drag — keep the same audio frames but slide the
      // timeline position. assetOffsetSamples + lengthSamples
      // unchanged; startSample shifts by the tick delta.
      patch.startSample = Math.max(
        0,
        d.origStartSample + Math.round(dStartTick * d.samplesPerTick),
      );
    } else if (d.kind === 'trim-l') {
      // Eat into the start of the asset: offset increases, length
      // shrinks by the same sample delta.
      const dSamples = Math.round(dStartTick * d.samplesPerTick);
      patch.startSample = Math.max(0, d.origStartSample + dSamples);
      patch.assetOffsetSamples = Math.max(0, d.origAssetOffset + dSamples);
      patch.lengthSamples = Math.max(1, d.origLengthSamples - dSamples);
    } else if (d.kind === 'trim-r') {
      // Extend / shrink trailing edge in the sample domain.
      const dSamples = Math.round(dLengthTicks * d.samplesPerTick);
      patch.lengthSamples = Math.max(1, d.origLengthSamples + dSamples);
    }
    updateAudioRegion(project, trackIdx, d.regionIdx, patch);
  }

  function previewLeftPx(regionIdx: number, baseStartTick: number): number {
    if (regionDrag && regionDrag.regionIdx === regionIdx) {
      return regionDrag.previewStartTick * PX_PER_TICK;
    }
    return baseStartTick * PX_PER_TICK;
  }

  function previewWidthPx(regionIdx: number, baseLengthTicks: number): number {
    if (regionDrag && regionDrag.regionIdx === regionIdx) {
      return Math.max(8, regionDrag.previewLengthTicks * PX_PER_TICK);
    }
    return Math.max(8, baseLengthTicks * PX_PER_TICK);
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
    <div class="timeline-wrap">
      <div
        class="timeline"
        style="width: {timelineWidthPx}px;"
        data-testid={`audio-timeline-${trackIdx}`}
        onpointermove={onTimelinePointerMove}
        onpointerup={onTimelinePointerUp}
        onpointercancel={onTimelinePointerUp}
        role="presentation"
      >
        {#each regions as r, i (`${r.assetHash}:${i}`)}
          {@const m = meta(r.assetHash)}
          {@const leftPx = previewLeftPx(i, r.startTick)}
          {@const widthPx = previewWidthPx(i, r.lengthTicks)}
          {@const fadeInPx = r.lengthSamples > 0
            ? (r.fadeInSamples / r.lengthSamples) * widthPx
            : 0}
          {@const fadeOutPx = r.lengthSamples > 0
            ? (r.fadeOutSamples / r.lengthSamples) * widthPx
            : 0}
          {@const dragging = regionDrag?.regionIdx === i}
          {@const selected = selectedRegionIdx === i}
          <div
            class="region"
            class:dragging
            class:selected
            data-testid={`audio-region-${trackIdx}-${i}`}
            style="left: {leftPx}px; width: {widthPx}px;"
            title={m?.sourceFilename ?? r.assetHash}
            onpointerdown={(e) => startRegionDrag(e, i, 'move')}
          >
            <Waveform hash={r.assetHash} widthPx={widthPx} />
            <!--
              Phase-10 M3c — trim handles. Two narrow strips on the
              left + right edges intercept pointerdown and start a
              `trim-l` / `trim-r` drag instead of the body's `move`.
              The cursor changes to `ew-resize` on hover so the
              affordance is discoverable.
            -->
            <div
              class="handle handle-l"
              data-testid={`audio-region-${trackIdx}-${i}-trim-l`}
              onpointerdown={(e) => startRegionDrag(e, i, 'trim-l')}
              role="presentation"
            ></div>
            <div
              class="handle handle-r"
              data-testid={`audio-region-${trackIdx}-${i}-trim-r`}
              onpointerdown={(e) => startRegionDrag(e, i, 'trim-r')}
              role="presentation"
            ></div>
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

  {#if selectedRegionIdx != null && regions[selectedRegionIdx]}
    {@const r = regions[selectedRegionIdx]}
    {@const sr = meta(r.assetHash)?.sampleRate ?? 48_000}
    {@const fadeInMs = (r.fadeInSamples / sr) * 1000}
    {@const fadeOutMs = (r.fadeOutSamples / sr) * 1000}
    <!--
      Phase-10 M3d — region edit panel. Inline (not in the right
      Inspector) so audio-only controls stay next to the timeline
      that owns them; matches how the piano-roll's velocity lane
      sits below its grid. Controls write to the Y.Doc directly via
      the per-field helpers — collab + persistence pick them up
      with no extra plumbing.
    -->
    <div
      class="region-inspector"
      data-testid={`audio-region-inspector-${trackIdx}`}
    >
      <header>
        <span class="title">Region {selectedRegionIdx + 1}</span>
        <button
          type="button"
          class="close"
          data-testid={`audio-region-inspector-${trackIdx}-close`}
          aria-label="Close region inspector"
          onclick={() => { selectedRegionIdx = null; }}
        >×</button>
      </header>
      <div class="rows">
        <label class="row">
          <span class="lbl">Gain</span>
          <input
            type="range"
            min="0" max="2" step="0.01"
            value={r.gain}
            data-testid={`audio-region-inspector-${trackIdx}-gain`}
            oninput={(e) => {
              const v = Number((e.currentTarget as HTMLInputElement).value);
              setAudioRegionGain(project, trackIdx, selectedRegionIdx!, v);
            }}
          />
          <span class="val mono">{r.gain.toFixed(2)}</span>
        </label>
        <label class="row">
          <span class="lbl">Fade in (ms)</span>
          <input
            type="number"
            min="0" step="1"
            value={Math.round(fadeInMs)}
            data-testid={`audio-region-inspector-${trackIdx}-fade-in`}
            oninput={(e) => {
              const ms = Number((e.currentTarget as HTMLInputElement).value);
              if (!Number.isFinite(ms)) return;
              setAudioRegionFade(
                project, trackIdx, selectedRegionIdx!,
                'in', Math.round((ms / 1000) * sr),
              );
            }}
          />
        </label>
        <label class="row">
          <span class="lbl">Fade out (ms)</span>
          <input
            type="number"
            min="0" step="1"
            value={Math.round(fadeOutMs)}
            data-testid={`audio-region-inspector-${trackIdx}-fade-out`}
            oninput={(e) => {
              const ms = Number((e.currentTarget as HTMLInputElement).value);
              if (!Number.isFinite(ms)) return;
              setAudioRegionFade(
                project, trackIdx, selectedRegionIdx!,
                'out', Math.round((ms / 1000) * sr),
              );
            }}
          />
        </label>
        <div class="row readonly">
          <span class="lbl">Start tick</span>
          <span class="val mono">{r.startTick}</span>
        </div>
        <div class="row readonly">
          <span class="lbl">Length (ticks)</span>
          <span class="val mono">{r.lengthTicks}</span>
        </div>
        <div class="row readonly">
          <span class="lbl">Asset offset</span>
          <span class="val mono">{r.assetOffsetSamples} sm</span>
        </div>
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
    cursor: grab;
    touch-action: none;
  }
  .region.dragging {
    cursor: grabbing;
    outline: 1px solid #ffd84a;
  }
  .region.selected {
    outline: 2px solid #7ad7ff;
    z-index: 1;
  }
  /* Phase-10 M3c — trim grips. The handle sits on top of the
     waveform but stays narrow enough that the body still receives
     pointerdown for `move`. `touch-action: none` lets the drag
     start cleanly without the browser firing scroll gestures. */
  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
    background: transparent;
    touch-action: none;
    z-index: 2;
  }
  .handle-l { left: 0; }
  .handle-r { right: 0; }
  .handle:hover {
    background: rgba(255, 216, 74, 0.35);
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
  /* Phase-10 M3d — inline region inspector. */
  .region-inspector {
    margin-top: 8px;
    background: #15171a;
    border: 1px solid #2a2a2a;
    padding: 8px 10px;
    color: #ccc;
  }
  .region-inspector header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .region-inspector .title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #aaa;
  }
  .region-inspector .close {
    appearance: none;
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #888;
    width: 18px;
    height: 18px;
    line-height: 16px;
    text-align: center;
    cursor: pointer;
    padding: 0;
    font-size: 13px;
  }
  .region-inspector .close:hover { color: #fff; border-color: #555; }
  .rows {
    display: grid;
    grid-template-columns: max-content 1fr max-content;
    column-gap: 10px;
    row-gap: 4px;
    align-items: center;
  }
  .row {
    display: contents;
  }
  .row .lbl {
    font-size: 10px;
    color: #888;
  }
  .row input[type="range"] {
    width: 100%;
  }
  .row input[type="number"] {
    width: 80px;
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 2px 4px;
    font: 11px ui-monospace, monospace;
  }
  .row .val {
    font-size: 10px;
    color: #aaa;
    text-align: right;
  }
  .mono {
    font-family: ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
  }
  .row.readonly .val {
    grid-column: 2 / -1;
    text-align: left;
    color: #888;
  }
</style>
