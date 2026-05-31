<script lang="ts">
  import { untrack } from 'svelte';
  import {
    listBlocksForTrack,
    getAudioRegions,
    getTrackKind,
    getTrackName,
    getTrackColor,
    moveBlock,
    resizeBlock,
    duplicateBlock,
    deleteBlock,
    STEP_TICKS,
    type Project,
  } from '../project';
  import {
    PX_PER_TICK,
    HEADER_WIDTH,
    LANE_HEIGHT,
    RULER_HEIGHT,
    pxToTick,
    snapTicks,
    songTotalTicks,
  } from './timeline';
  import TimelineRuler from './TimelineRuler.svelte';
  import BlockView from './BlockView.svelte';

  const {
    project,
    canEdit = true,
    selectedTrackIdx = 0,
    onSelectTrack = () => {},
    onDrillIn = () => {},
    playheadTick = 0,
  }: {
    project: Project;
    canEdit?: boolean;
    selectedTrackIdx?: number;
    onSelectTrack?: (idx: number) => void;
    /// Double-click a block → open the per-track editor for its track.
    onDrillIn?: (idx: number) => void;
    playheadTick?: number;
  } = $props();

  interface LaneItem {
    id: string;
    /// 'block' = a MIDI pattern block (draggable here); 'audio' = an
    /// audio region (read-only in the arrangement — edited in the
    /// per-track AudioTrackView via drill-in).
    kind: 'block' | 'audio';
    startTick: number;
    lengthTicks: number;
    label: string;
    loop: boolean;
  }
  interface Lane {
    trackIdx: number;
    name: string;
    color: string;
    trackKind: string;
    items: LaneItem[];
  }

  function buildLanes(): Lane[] {
    const out: Lane[] = [];
    for (let t = 0; t < project.tracks.length; t++) {
      const trackKind = getTrackKind(project, t);
      let items: LaneItem[];
      if (trackKind === 'Audio') {
        items = getAudioRegions(project, t).map((r, i) => ({
          id: `audio-${t}-${i}`,
          kind: 'audio' as const,
          startTick: r.startTick,
          lengthTicks: r.lengthTicks,
          label: r.assetHash.slice(0, 8),
          loop: false,
        }));
      } else {
        items = listBlocksForTrack(project, t).map((b) => ({
          id: b.id,
          kind: 'block' as const,
          startTick: b.startTick,
          lengthTicks: b.lengthTicks,
          label: b.kind === 'StepSeq' ? 'Step' : b.kind === 'PianoRoll' ? 'Piano' : 'Block',
          loop: b.loop,
        }));
      }
      out.push({ trackIdx: t, name: getTrackName(project, t), color: getTrackColor(project, t), trackKind, items });
    }
    return out;
  }

  let lanes = $state<Lane[]>(untrack(() => buildLanes()));
  let selectedBlockIds = $state<Set<string>>(new Set());

  function refresh() {
    lanes = buildLanes();
  }

  $effect(() => {
    refresh();
    project.trackById.observeDeep(refresh);
    project.tracks.observe(refresh);
    project.assets.observe(refresh);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      project.trackById.unobserveDeep(refresh);
      project.tracks.unobserve(refresh);
      project.assets.unobserve(refresh);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  // ---- Drag state (move / resize), preview-then-commit ------------------

  type DragMode = 'move' | 'resize';
  let drag: {
    blockId: string;
    mode: DragMode;
    startX: number;
    origStart: number;
    origLen: number;
    alt: boolean;
    moved: boolean;
  } | null = null;
  let preview = $state<{ blockId: string; startTick: number; lengthTicks: number } | null>(null);

  const MIN_LEN = STEP_TICKS;

  function startDrag(e: PointerEvent, item: LaneItem, mode: DragMode) {
    if (!canEdit || item.kind !== 'block') return;
    drag = {
      blockId: item.id,
      mode,
      startX: e.clientX,
      origStart: item.startTick,
      origLen: item.lengthTicks,
      alt: e.altKey,
      moved: false,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    const dxPx = e.clientX - drag.startX;
    if (Math.abs(dxPx) > 3) drag.moved = true;
    const dxTicks = pxToTick(dxPx);
    if (drag.mode === 'move') {
      const startTick = snapTicks(Math.max(0, drag.origStart + dxTicks));
      preview = { blockId: drag.blockId, startTick, lengthTicks: drag.origLen };
    } else {
      const lengthTicks = Math.max(MIN_LEN, snapTicks(drag.origLen + dxTicks));
      preview = { blockId: drag.blockId, startTick: drag.origStart, lengthTicks };
    }
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    const d = drag;
    const p = preview;
    drag = null;
    preview = null;
    if (!d) return;
    if (d.moved && p) {
      if (d.mode === 'move') {
        if (d.alt) duplicateBlock(project, d.blockId, p.startTick);
        else moveBlock(project, d.blockId, p.startTick);
      } else {
        resizeBlock(project, d.blockId, p.lengthTicks);
      }
    } else {
      // A click (no real drag) selects the block.
      selectedBlockIds = new Set([d.blockId]);
    }
    refresh();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!canEdit) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (selectedBlockIds.size === 0) return;
    // Don't hijack deletes while typing in an input.
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    e.preventDefault();
    for (const id of selectedBlockIds) deleteBlock(project, id);
    selectedBlockIds = new Set();
    refresh();
  }

  function itemGeom(item: LaneItem): { startTick: number; lengthTicks: number } {
    if (preview && preview.blockId === item.id) {
      return { startTick: preview.startTick, lengthTicks: preview.lengthTicks };
    }
    return { startTick: item.startTick, lengthTicks: item.lengthTicks };
  }

  const totalTicks = $derived.by(() => {
    void lanes;
    void preview;
    return songTotalTicks(project);
  });
  const contentWidthPx = $derived(totalTicks * PX_PER_TICK);
  const playheadLeftPx = $derived(HEADER_WIDTH + Math.max(0, playheadTick) * PX_PER_TICK);
  const lanesHeightPx = $derived(lanes.length * LANE_HEIGHT);
</script>

<div class="arrangement" data-testid="arrangement-view">
  <div class="scroll">
    <div class="timeline" style:width="{HEADER_WIDTH + contentWidthPx}px">
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
              {@const g = itemGeom(item)}
              <BlockView
                left={g.startTick * PX_PER_TICK}
                width={g.lengthTicks * PX_PER_TICK}
                startTick={g.startTick}
                lengthTicks={g.lengthTicks}
                label={item.label}
                color={lane.color}
                loop={item.loop}
                selected={selectedBlockIds.has(item.id)}
                editable={canEdit && item.kind === 'block'}
                testid={`arrange-block-${lane.trackIdx}-${item.id}`}
                onPointerDownBody={(e) => startDrag(e, item, 'move')}
                onPointerDownResize={(e) => startDrag(e, item, 'resize')}
                onDblClick={() => onDrillIn(lane.trackIdx)}
              />
            {/each}
          </div>
        </div>
      {/each}

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
