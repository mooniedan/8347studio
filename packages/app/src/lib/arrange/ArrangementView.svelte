<script lang="ts">
  import { untrack } from 'svelte';
  import {
    listBlocksForTrack,
    getAudioRegions,
    getTrackKind,
    getTrackName,
    getTrackColor,
    type Project,
  } from '../project';
  import {
    PX_PER_TICK,
    HEADER_WIDTH,
    LANE_HEIGHT,
    RULER_HEIGHT,
    songTotalTicks,
  } from './timeline';
  import TimelineRuler from './TimelineRuler.svelte';
  import BlockView from './BlockView.svelte';

  const {
    project,
    canEdit = true,
    selectedTrackIdx = 0,
    onSelectTrack = () => {},
    playheadTick = 0,
  }: {
    project: Project;
    /// Accepted for the M4 editing pass; M3 is read-only (selecting a
    /// lane is a read action, allowed for viewers too).
    canEdit?: boolean;
    selectedTrackIdx?: number;
    onSelectTrack?: (idx: number) => void;
    playheadTick?: number;
  } = $props();

  interface LaneItem {
    id: string;
    startTick: number;
    lengthTicks: number;
    label: string;
    loop: boolean;
  }
  interface Lane {
    trackIdx: number;
    name: string;
    color: string;
    kind: string;
    items: LaneItem[];
  }

  function buildLanes(): Lane[] {
    const out: Lane[] = [];
    for (let t = 0; t < project.tracks.length; t++) {
      const kind = getTrackKind(project, t);
      let items: LaneItem[];
      if (kind === 'Audio') {
        items = getAudioRegions(project, t).map((r, i) => ({
          id: `audio-${t}-${i}`,
          startTick: r.startTick,
          lengthTicks: r.lengthTicks,
          label: r.assetHash.slice(0, 8),
          loop: false,
        }));
      } else {
        items = listBlocksForTrack(project, t).map((b) => ({
          id: b.id,
          startTick: b.startTick,
          lengthTicks: b.lengthTicks,
          label: b.kind === 'StepSeq' ? 'Step' : b.kind === 'PianoRoll' ? 'Piano' : 'Block',
          loop: b.loop,
        }));
      }
      out.push({ trackIdx: t, name: getTrackName(project, t), color: getTrackColor(project, t), kind, items });
    }
    return out;
  }

  let lanes = $state<Lane[]>(untrack(() => buildLanes()));

  function refresh() {
    lanes = buildLanes();
  }

  $effect(() => {
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

  const totalTicks = $derived.by(() => {
    // `lanes` is a reactive dep so width grows as content changes.
    void lanes;
    return songTotalTicks(project);
  });
  const contentWidthPx = $derived(totalTicks * PX_PER_TICK);
  const playheadLeftPx = $derived(HEADER_WIDTH + Math.max(0, playheadTick) * PX_PER_TICK);
  const lanesHeightPx = $derived(lanes.length * LANE_HEIGHT);
</script>

<div class="arrangement" data-testid="arrangement-view">
  <div class="scroll">
    <div class="timeline" style:width="{HEADER_WIDTH + contentWidthPx}px">
      <!-- Ruler row: sticky corner over the header column + the bar ruler. -->
      <div class="ruler-row" style:height="{RULER_HEIGHT}px">
        <div class="corner" style:width="{HEADER_WIDTH}px"></div>
        <TimelineRuler {totalTicks} />
      </div>

      {#each lanes as lane (lane.trackIdx)}
        <div
          class="lane"
          class:selected={lane.trackIdx === selectedTrackIdx}
          data-testid="arrange-lane-{lane.trackIdx}"
          style:height="{LANE_HEIGHT}px"
        >
          <button
            class="lane-head"
            data-testid="arrange-lane-head-{lane.trackIdx}"
            style:width="{HEADER_WIDTH}px"
            onclick={() => onSelectTrack(lane.trackIdx)}
          >
            <span class="stripe" style:background={lane.color}></span>
            <span class="name">{lane.name}</span>
          </button>
          <div class="lane-body" style:width="{contentWidthPx}px">
            {#each lane.items as item (item.id)}
              <BlockView
                left={item.startTick * PX_PER_TICK}
                width={item.lengthTicks * PX_PER_TICK}
                startTick={item.startTick}
                lengthTicks={item.lengthTicks}
                label={item.label}
                color={lane.color}
                loop={item.loop}
                selected={lane.trackIdx === selectedTrackIdx}
                testid={`arrange-block-${lane.trackIdx}-${item.id}`}
              />
            {/each}
          </div>
        </div>
      {/each}

      <!-- Single continuous playhead over the lanes (offset past the
           sticky header column). -->
      <div
        class="playhead"
        data-testid="arrange-playhead"
        style:left="{playheadLeftPx}px"
        style:top="{RULER_HEIGHT}px"
        style:height="{lanesHeightPx}px"
      ></div>
    </div>
  </div>
</div>

<style>
  .arrangement {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-0);
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .timeline {
    position: relative;
  }
  .ruler-row {
    display: flex;
    position: sticky;
    top: 0;
    z-index: 3;
  }
  .corner {
    flex: 0 0 auto;
    position: sticky;
    left: 0;
    z-index: 4;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border, #333);
    border-right: 1px solid var(--border, #333);
  }
  .lane {
    display: flex;
    border-bottom: 1px solid var(--border, #2a2a2a);
  }
  .lane.selected .lane-head {
    background: var(--bg-2);
  }
  .lane.selected .lane-body {
    background: color-mix(in srgb, var(--accent-hi, #6cf) 6%, transparent);
  }
  .lane-head {
    flex: 0 0 auto;
    position: sticky;
    left: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    background: var(--bg-1);
    border: none;
    border-right: 1px solid var(--border, #333);
    color: var(--fg-1);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .lane-head .stripe {
    width: 4px;
    height: 22px;
    border-radius: 2px;
    flex: 0 0 auto;
  }
  .lane-head .name {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lane-body {
    position: relative;
    flex: 0 0 auto;
  }
  .playhead {
    position: absolute;
    width: 2px;
    background: var(--accent-hi, #6cf);
    pointer-events: none;
    z-index: 1;
  }
</style>
