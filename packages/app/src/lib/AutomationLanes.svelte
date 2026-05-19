<script lang="ts">
  import { untrack } from 'svelte';
  import {
    STEP_TICKS,
    STEPS_PER_CLIP,
    type Project,
    type AutoTargetKind,
    type AutomationLaneView,
    addAutomationPoint,
    listAutomationLanes,
    removeAutomationPoint,
  } from './project';

  /**
   * Phase-10 M4a — automation lane visuals.
   *
   * Renders every automation lane attached to `trackIdx` as a stack
   * of SVG mini-editors below the main track editor. Each lane:
   *   - draws a polyline through its points (auto-scaled to the
   *     lane's own observed min/max — values can be 0..1 normalised
   *     params or wide-range fields like a filter cutoff);
   *   - shows draggable circles at every point;
   *   - lets you click empty area to add a point (value = midpoint
   *     of the current range);
   *   - shift-click to remove a point.
   *
   * Commits land in single Y.Doc transactions so collab peers see
   * one update per gesture.
   */
  const {
    project,
    trackIdx,
  }: {
    project: Project;
    trackIdx: number;
  } = $props();

  const PX_PER_TICK = 36 / STEP_TICKS;
  const DEFAULT_TICKS = STEPS_PER_CLIP * 4 * STEP_TICKS;
  const LANE_HEIGHT = 60;

  let lanes = $state<AutomationLaneView[]>(
    untrack(() => listAutomationLanes(project).filter((l) => l.trackIdx === trackIdx)),
  );

  function refresh() {
    lanes = listAutomationLanes(project).filter((l) => l.trackIdx === trackIdx);
  }

  $effect(() => {
    void trackIdx;
    refresh();
    project.automation.observeDeep(refresh);
    project.tracks.observe(refresh);
    return () => {
      project.automation.unobserveDeep(refresh);
      project.tracks.unobserve(refresh);
    };
  });

  /// Visible-tick range — at least the default 4 bars, expanded if
  /// any point sits beyond it. Mirrors the audio timeline's "grow
  /// past default so nothing falls off-screen" behaviour.
  function laneTotalTicks(l: AutomationLaneView): number {
    let max = DEFAULT_TICKS;
    for (const p of l.points) if (p.tick > max) max = p.tick;
    return max;
  }

  interface LaneRange { min: number; max: number; }
  /// Auto-scale: pick the lane's own min/max so a wide-range param
  /// (filter cutoff 0..20k) and a normalised param (0..1) both fill
  /// the lane visually. Falls back to 0..1 when points are missing
  /// or the range collapses.
  function laneRange(l: AutomationLaneView): LaneRange {
    if (l.points.length === 0) return { min: 0, max: 1 };
    let lo = l.points[0].value;
    let hi = lo;
    for (const p of l.points) {
      if (p.value < lo) lo = p.value;
      if (p.value > hi) hi = p.value;
    }
    if (hi - lo < 1e-6) {
      const center = lo;
      return { min: center - 0.5, max: center + 0.5 };
    }
    return { min: lo, max: hi };
  }

  function pointX(tick: number): number {
    return tick * PX_PER_TICK;
  }
  function pointY(value: number, range: LaneRange): number {
    const t = (value - range.min) / (range.max - range.min);
    return LANE_HEIGHT - 4 - t * (LANE_HEIGHT - 8);
  }

  function polylineFor(l: AutomationLaneView, range: LaneRange): string {
    return l.points
      .map((p) => `${pointX(p.tick)},${pointY(p.value, range)}`)
      .join(' ');
  }

  function laneKey(l: AutomationLaneView): string {
    return `${l.target}:${l.slotIdx}:${l.paramId}`;
  }

  function laneLabel(l: AutomationLaneView): string {
    const kind = l.target === 'instrument' ? 'inst' : `ins ${l.slotIdx}`;
    return `${kind} · param ${l.paramId}`;
  }

  /// Drag state — identity by laneKey + point index. Preview tick
  /// and value live in component state so the polyline updates in
  /// real-time; the actual Y.Doc commit happens on pointer-up via a
  /// single remove-then-add so the array stays insertion-sorted.
  interface PointDrag {
    laneKey: string;
    target: AutoTargetKind;
    slotIdx: number;
    paramId: number;
    pointIdx: number;
    origTick: number;
    origValue: number;
    range: LaneRange;
    totalTicks: number;
    laneRect: DOMRect;
    previewTick: number;
    previewValue: number;
  }
  let pointDrag = $state<PointDrag | null>(null);

  function onPointPointerDown(
    e: PointerEvent,
    l: AutomationLaneView,
    pointIdx: number,
  ) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey) {
      removeAutomationPoint(
        project, trackIdx, l.target, l.slotIdx, l.paramId, pointIdx,
      );
      return;
    }
    const target = e.currentTarget as SVGElement;
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const svg = target.closest('svg') as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const r = laneRange(l);
    const p = l.points[pointIdx];
    pointDrag = {
      laneKey: laneKey(l),
      target: l.target,
      slotIdx: l.slotIdx,
      paramId: l.paramId,
      pointIdx,
      origTick: p.tick,
      origValue: p.value,
      range: r,
      totalTicks: laneTotalTicks(l),
      laneRect: rect,
      previewTick: p.tick,
      previewValue: p.value,
    };
  }

  function onLanePointerMove(e: PointerEvent) {
    if (!pointDrag) return;
    const rect = pointDrag.laneRect;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const tick = Math.round((x / PX_PER_TICK) / STEP_TICKS) * STEP_TICKS;
    const t = 1 - (y - 4) / Math.max(1, rect.height - 8);
    const clampedT = Math.max(0, Math.min(1, t));
    const value = pointDrag.range.min
      + clampedT * (pointDrag.range.max - pointDrag.range.min);
    pointDrag = { ...pointDrag, previewTick: Math.max(0, tick), previewValue: value };
  }

  function onLanePointerUp(e: PointerEvent) {
    const d = pointDrag;
    if (!d) return;
    pointDrag = null;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
    if (d.previewTick === d.origTick && d.previewValue === d.origValue) return;
    project.doc.transact(() => {
      removeAutomationPoint(
        project, trackIdx, d.target, d.slotIdx, d.paramId, d.pointIdx,
      );
      addAutomationPoint(
        project, trackIdx, d.target, d.slotIdx, d.paramId,
        { tick: d.previewTick, value: d.previewValue },
      );
    });
  }

  function onLaneBackgroundPointerDown(e: PointerEvent, l: AutomationLaneView) {
    if (e.button !== 0) return;
    // Skip when the click landed on an actual point (its own handler
    // will fire), but accept clicks that hit decorative children like
    // the polyline or background gridlines.
    if ((e.target as SVGElement).tagName === 'circle') return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const r = laneRange(l);
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tick = Math.max(
      0,
      Math.round((x / PX_PER_TICK) / STEP_TICKS) * STEP_TICKS,
    );
    const tNorm = 1 - (y - 4) / Math.max(1, rect.height - 8);
    const clampedT = Math.max(0, Math.min(1, tNorm));
    const value = r.min + clampedT * (r.max - r.min);
    addAutomationPoint(
      project, trackIdx, l.target, l.slotIdx, l.paramId,
      { tick, value },
    );
  }
</script>

{#if lanes.length > 0}
  <section
    class="automation"
    data-testid={`automation-lanes-${trackIdx}`}
    aria-label="Automation lanes"
  >
    {#each lanes as l (laneKey(l))}
      {@const range = laneRange(l)}
      {@const totalTicks = laneTotalTicks(l)}
      {@const widthPx = totalTicks * PX_PER_TICK}
      <div class="lane" data-testid={`automation-lane-${trackIdx}-${l.target}-${l.slotIdx}-${l.paramId}`}>
        <header>
          <span class="title">{laneLabel(l)}</span>
          <span class="range mono">{range.min.toFixed(2)} – {range.max.toFixed(2)}</span>
        </header>
        <div class="svg-wrap">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={widthPx}
            height={LANE_HEIGHT}
            viewBox="0 0 {widthPx} {LANE_HEIGHT}"
            preserveAspectRatio="none"
            class="lane-svg"
            onpointermove={onLanePointerMove}
            onpointerup={onLanePointerUp}
            onpointercancel={onLanePointerUp}
            onpointerdown={(e) => onLaneBackgroundPointerDown(e, l)}
            role="presentation"
          >
            <rect x="0" y="0" width={widthPx} height={LANE_HEIGHT} fill="#15171a" />
            <line x1="0" y1={LANE_HEIGHT - 4} x2={widthPx} y2={LANE_HEIGHT - 4} stroke="#2a2a2a" />
            <line x1="0" y1="4" x2={widthPx} y2="4" stroke="#2a2a2a" />
            {#if l.points.length >= 2}
              <polyline
                points={polylineFor(l, range)}
                fill="none"
                stroke="#ff8c00"
                stroke-width="1.5"
              />
            {/if}
            {#each l.points as p, i}
              {@const isDragged = pointDrag?.laneKey === laneKey(l) && pointDrag?.pointIdx === i}
              {@const cx = isDragged ? pointX(pointDrag!.previewTick) : pointX(p.tick)}
              {@const cy = isDragged ? pointY(pointDrag!.previewValue, range) : pointY(p.value, range)}
              <circle
                cx={cx}
                cy={cy}
                r="4"
                class="pt"
                class:dragging={isDragged}
                data-testid={`automation-point-${trackIdx}-${l.target}-${l.slotIdx}-${l.paramId}-${i}`}
                onpointerdown={(e) => onPointPointerDown(e, l, i)}
              />
            {/each}
          </svg>
        </div>
      </div>
    {/each}
  </section>
{/if}

<style>
  .automation {
    background: #131313;
    border: 1px solid #2a2a2a;
    color: #ccc;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lane header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 2px 0;
    color: #aaa;
  }
  .lane .title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .lane .range {
    font-size: 10px;
    color: #888;
  }
  .mono {
    font-family: ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
  }
  .svg-wrap {
    overflow-x: auto;
    border: 1px solid #2a2a2a;
  }
  .lane-svg {
    display: block;
    cursor: copy; /* invites click-to-add */
    touch-action: none;
  }
  .pt {
    fill: #ff8c00;
    stroke: #ffcc88;
    stroke-width: 1;
    cursor: grab;
  }
  .pt:hover {
    fill: #ffaa33;
  }
  .pt.dragging {
    cursor: grabbing;
    stroke: #ffd84a;
    stroke-width: 2;
  }
</style>
