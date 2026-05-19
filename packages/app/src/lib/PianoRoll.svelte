<script lang="ts">
  import { untrack } from 'svelte';
  import * as audio from './audio';
  import {
    LOW_MIDI,
    STEP_TICKS,
    STEPS_PER_CLIP,
    type Project,
    type PianoRollNote,
    getPianoRollClipForTrack,
    getTrackPluginId,
    readPianoRollNotes,
    addPianoRollNote,
    removePianoRollNoteAt,
    setPianoRollNoteVelocity,
  } from './project';

  import type { CollabState } from './collab.svelte';

  const {
    project,
    trackIdx,
    collab = null,
  }: {
    project: Project;
    trackIdx: number;
    /// Phase-9 M4 — optional collab state. Hover events broadcast our
    /// `pianoCell` so peers see a ghost cell on the same coordinate;
    /// peers' cells render as colored borders below.
    collab?: CollabState | null;
  } = $props();

  /// Color → highlight for peers hovering this track's cells. Other
  /// tracks' peers are ignored so we don't show a phantom highlight
  /// on tracks they're not actually looking at.
  function peerCellColor(midi: number, col: number): string | null {
    if (!collab) return null;
    for (const p of collab.peers) {
      const cell = p.state.pianoCell;
      if (cell && cell.trackIdx === trackIdx && cell.midi === midi && cell.col === col) {
        return p.state.user?.color ?? 'var(--accent-hi)';
      }
    }
    return null;
  }

  function broadcastHover(col: number, midi: number) {
    collab?.setPianoCell({ trackIdx, midi, col });
  }
  function clearHoverBroadcast() {
    collab?.setPianoCell(null);
  }

  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = (m: number) => BLACK.has(((m % 12) + 12) % 12);
  const noteName = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

  /// Drum-kit pitch map — General-MIDI subset that the first-party
  /// drumkit plugin responds to. Renders top-down (highest pitch at
  /// the top, like a melodic piano-roll).
  const DRUM_ROWS: { midi: number; label: string }[] = [
    { midi: 46, label: 'Open Hat' },
    { midi: 42, label: 'Closed Hat' },
    { midi: 39, label: 'Clap' },
    { midi: 38, label: 'Snare' },
    { midi: 36, label: 'Kick' },
  ];

  // svelte-ignore state_referenced_locally — initial-capture is
  // immediately re-synced by the $effect below.
  let pluginId = $state(getTrackPluginId(project, trackIdx));
  $effect(() => {
    const idx = trackIdx;
    const refresh = () => { pluginId = getTrackPluginId(project, idx); };
    refresh();
    project.trackById.observeDeep(refresh);
    project.tracks.observe(refresh);
    return () => {
      project.trackById.unobserveDeep(refresh);
      project.tracks.unobserve(refresh);
    };
  });

  // C3..C5 inclusive for melodic tracks; drum-kit pitches when the
  // track holds the drumkit plugin (otherwise the user can't see or
  // edit the notes — drum pitches sit a whole octave below C3).
  const rowDefs = $derived.by((): { midi: number; label: string; isAccent: boolean }[] => {
    if (pluginId === 'builtin:drumkit') {
      return DRUM_ROWS.map((r) => ({ midi: r.midi, label: r.label, isAccent: false }));
    }
    const HIGH = LOW_MIDI + 24; // 72 = C5
    const N = HIGH - LOW_MIDI + 1;
    return Array.from({ length: N }, (_, r) => {
      const m = HIGH - r;
      return { midi: m, label: noteName(m), isAccent: isBlack(m) };
    });
  });

  let notes = $state<PianoRollNote[]>(untrack(() => snapshotNotes()));
  // Clip-tick length — the visible grid scales to match. Falls back
  // to one bar for clips without an explicit length so the default
  // melodic editor stays its familiar 16-column form. Synced via
  // the same clip observer as `notes` (in the $effect below).
  // svelte-ignore state_referenced_locally
  let clipLengthTicks = $state(untrack(() => snapshotClipLength()));
  /// Visible column count derived from the clip length.
  const cols = $derived(Math.max(1, Math.round(clipLengthTicks / STEP_TICKS)));
  // Column index currently under the playhead; -1 = stopped.
  let playheadCol = $state(-1);

  function snapshotNotes(): PianoRollNote[] {
    const clip = getPianoRollClipForTrack(project, trackIdx);
    return clip ? readPianoRollNotes(clip) : [];
  }

  function snapshotClipLength(): number {
    const clip = getPianoRollClipForTrack(project, trackIdx);
    const raw = clip?.get('lengthTicks');
    if (typeof raw === 'number' && raw > 0) return raw;
    return STEPS_PER_CLIP * STEP_TICKS;
  }

  /// The note that occupies `(col, midi)` if any — i.e. a note on
  /// this pitch row whose [startTick, startTick + lengthTicks) tick
  /// range contains the column. Used both for rendering (paint every
  /// column the note spans) and for click-to-remove (pick the right
  /// note even when the user clicks a non-start column).
  function noteCovering(col: number, midi: number): PianoRollNote | null {
    const tick = col * STEP_TICKS;
    for (const n of notes) {
      if (n.pitch !== midi) continue;
      if (n.startTick <= tick && tick < n.startTick + n.lengthTicks) return n;
    }
    return null;
  }

  /// Phase-10 M2 drag state. Three kinds:
  ///   - `create` — pointer-down on an empty cell. Span = [start, curr]
  ///     on the start pitch row. Commits a new note.
  ///   - `move` — pointer-down on the interior of an existing note.
  ///     Tracks delta in cols + midi rows; ghost shows the note at
  ///     the dragged position. Commit removes the original and adds
  ///     a fresh note at (newPitch, newStartTick) with the same
  ///     lengthTicks and velocity.
  ///   - `resize` — pointer-down near the right edge of an existing
  ///     note's last cell. Anchor stays at the note's startTick; the
  ///     end follows the pointer. Commit updates lengthTicks.
  type DragKind = 'create' | 'move' | 'resize';
  interface Drag {
    kind: DragKind;
    startCol: number;
    startMidi: number;
    currCol: number;
    currMidi: number;
    /// For move + resize: the note being manipulated.
    orig?: PianoRollNote;
  }
  let drag = $state<Drag | null>(null);

  /// Computed ghost span — what cells the in-flight drag would paint.
  /// Returns `null` when there's no drag or when the kind has no
  /// visible ghost (shouldn't happen given the three kinds above).
  function ghostFor(col: number, midi: number): boolean {
    if (!drag) return false;
    if (drag.kind === 'create') {
      if (midi !== drag.startMidi) return false;
      const lo = Math.min(drag.startCol, drag.currCol);
      const hi = Math.max(drag.startCol, drag.currCol);
      return col >= lo && col <= hi;
    }
    if (drag.kind === 'resize' && drag.orig) {
      if (midi !== drag.orig.pitch) return false;
      const startCol = drag.orig.startTick / STEP_TICKS;
      const endCol = Math.max(startCol, drag.currCol);
      return col >= startCol && col <= endCol;
    }
    if (drag.kind === 'move' && drag.orig) {
      const startCol = drag.orig.startTick / STEP_TICKS;
      const spanCols = drag.orig.lengthTicks / STEP_TICKS;
      const dCol = drag.currCol - drag.startCol;
      const dMidi = drag.currMidi - drag.startMidi;
      const newStart = startCol + dCol;
      const newPitch = drag.orig.pitch + dMidi;
      if (midi !== newPitch) return false;
      return col >= newStart && col < newStart + spanCols;
    }
    return false;
  }

  /// True when `(col, midi)` is the leftmost cell of the ghost span —
  /// drives the `note-start` accent so the in-flight drag previews
  /// the same "first cell brighter" look the committed note has.
  function isGhostStart(col: number, midi: number): boolean {
    if (!drag) return false;
    if (drag.kind === 'create') {
      if (midi !== drag.startMidi) return false;
      return col === Math.min(drag.startCol, drag.currCol);
    }
    if (drag.kind === 'resize' && drag.orig) {
      const startCol = drag.orig.startTick / STEP_TICKS;
      return midi === drag.orig.pitch && col === startCol;
    }
    if (drag.kind === 'move' && drag.orig) {
      const startCol = drag.orig.startTick / STEP_TICKS;
      const dCol = drag.currCol - drag.startCol;
      const dMidi = drag.currMidi - drag.startMidi;
      return midi === drag.orig.pitch + dMidi && col === startCol + dCol;
    }
    return false;
  }

  /// True when `(col, midi)` belongs to the original note that's
  /// currently being moved or resized — we hide the underlying
  /// `.on` paint so only the ghost is visible during the drag.
  function isMovingOriginalCell(col: number, midi: number): boolean {
    if (!drag || !drag.orig) return false;
    if (drag.kind === 'resize') return false; // resize keeps the start in place
    if (midi !== drag.orig.pitch) return false;
    const startCol = drag.orig.startTick / STEP_TICKS;
    const endCol = startCol + drag.orig.lengthTicks / STEP_TICKS - 1;
    return col >= startCol && col <= endCol;
  }

  /// Cell-x ratio within the last 25% of the cell counts as a resize
  /// grip — applies only on the last column of a covering note.
  const RESIZE_GRIP_RATIO = 0.75;

  function onCellPointerDown(e: PointerEvent, col: number, midi: number) {
    if (e.button !== 0) return;
    const existing = noteCovering(col, midi);
    const target = e.currentTarget as HTMLElement;
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }

    if (existing) {
      const startCol = existing.startTick / STEP_TICKS;
      const spanCols = existing.lengthTicks / STEP_TICKS;
      const isLastCol = col === startCol + spanCols - 1;
      const rect = target.getBoundingClientRect();
      const xRatio = (e.clientX - rect.left) / Math.max(1, rect.width);
      if (isLastCol && xRatio >= RESIZE_GRIP_RATIO) {
        drag = {
          kind: 'resize',
          startCol: col,
          startMidi: midi,
          currCol: col,
          currMidi: midi,
          orig: existing,
        };
        return;
      }
      drag = {
        kind: 'move',
        startCol: col,
        startMidi: midi,
        currCol: col,
        currMidi: midi,
        orig: existing,
      };
      return;
    }
    drag = {
      kind: 'create',
      startCol: col,
      startMidi: midi,
      currCol: col,
      currMidi: midi,
    };
  }

  function onCellPointerEnter(col: number, midi: number) {
    if (!drag) {
      broadcastHover(col, midi);
      return;
    }
    if (drag.kind === 'create' || drag.kind === 'resize') {
      // create / resize stay on the original pitch row.
      drag = { ...drag, currCol: col, currMidi: drag.startMidi };
    } else {
      // move tracks both col and midi.
      drag = { ...drag, currCol: col, currMidi: midi };
    }
  }

  function onCellPointerUp(e: PointerEvent) {
    const d = drag;
    drag = null;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
    if (!d) return;
    commitDrag(d);
  }

  function commitDrag(d: Drag): void {
    const clip = getPianoRollClipForTrack(project, trackIdx);
    if (!clip) return;

    // Pointer-down on an existing note that never moved is a tap-to-
    // remove (preserves legacy click-anywhere-on-note → delete from
    // M2a). Move and resize both reach this branch when dCol/dMidi
    // collapse to zero.
    if (
      (d.kind === 'move' || d.kind === 'resize') &&
      d.orig &&
      d.startCol === d.currCol &&
      d.startMidi === d.currMidi
    ) {
      removePianoRollNoteAt(project, clip, d.orig.pitch, d.orig.startTick);
      return;
    }

    if (d.kind === 'create') {
      // Tap: add or remove at the cell.
      if (d.startCol === d.currCol) {
        const existing = noteCovering(d.startCol, d.startMidi);
        if (existing) {
          removePianoRollNoteAt(project, clip, d.startMidi, existing.startTick);
        } else {
          addPianoRollNote(project, clip, {
            pitch: d.startMidi,
            velocity: 100,
            startTick: d.startCol * STEP_TICKS,
            lengthTicks: STEP_TICKS,
          });
        }
        return;
      }
      // Multi-col drag: leftmost wins.
      const lo = Math.min(d.startCol, d.currCol);
      const hi = Math.max(d.startCol, d.currCol);
      const covering = noteCovering(lo, d.startMidi);
      if (covering) {
        removePianoRollNoteAt(project, clip, d.startMidi, covering.startTick);
      }
      addPianoRollNote(project, clip, {
        pitch: d.startMidi,
        velocity: 100,
        startTick: lo * STEP_TICKS,
        lengthTicks: (hi - lo + 1) * STEP_TICKS,
      });
      return;
    }

    if (d.kind === 'resize' && d.orig) {
      const startCol = d.orig.startTick / STEP_TICKS;
      // Pointer at or before the start cell collapses the note to
      // 1 step rather than allowing a negative-length write.
      const newEndCol = Math.max(startCol, d.currCol);
      const newLengthTicks = (newEndCol - startCol + 1) * STEP_TICKS;
      if (newLengthTicks === d.orig.lengthTicks) return; // no-op
      removePianoRollNoteAt(project, clip, d.orig.pitch, d.orig.startTick);
      addPianoRollNote(project, clip, {
        pitch: d.orig.pitch,
        velocity: d.orig.velocity,
        startTick: d.orig.startTick,
        lengthTicks: newLengthTicks,
      });
      return;
    }

    if (d.kind === 'move' && d.orig) {
      const dCol = d.currCol - d.startCol;
      const dMidi = d.currMidi - d.startMidi;
      if (dCol === 0 && dMidi === 0) return;
      const newStartTick = Math.max(0, d.orig.startTick + dCol * STEP_TICKS);
      const newPitch = Math.max(0, Math.min(127, d.orig.pitch + dMidi));
      removePianoRollNoteAt(project, clip, d.orig.pitch, d.orig.startTick);
      addPianoRollNote(project, clip, {
        pitch: newPitch,
        velocity: d.orig.velocity,
        startTick: newStartTick,
        lengthTicks: d.orig.lengthTicks,
      });
    }
  }

  /// Phase-10 M2c — velocity-lane drag. While a bar is being dragged,
  /// `velDrag` carries the identity of the note plus the lane element
  /// so we can recompute the y-ratio against the same rect on every
  /// pointermove without re-querying the DOM.
  const VELOCITY_MIN = 30;
  const VELOCITY_MAX = 127;
  let velDrag = $state<
    | { pitch: number; startTick: number; lane: HTMLElement; pointerId: number }
    | null
  >(null);

  function yToVelocity(clientY: number, lane: HTMLElement): number {
    const rect = lane.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / Math.max(1, rect.height);
    const clamped = Math.max(0, Math.min(1, ratio));
    return Math.round(VELOCITY_MIN + clamped * (VELOCITY_MAX - VELOCITY_MIN));
  }

  function onVelBarPointerDown(
    e: PointerEvent,
    pitch: number,
    startTick: number,
  ) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const lane = (e.currentTarget as HTMLElement).closest('.vel-lane') as HTMLElement | null;
    if (!lane) return;
    // Pointer capture keeps move/up events routed to the lane even
    // when the cursor leaves it. Synthetic PointerEvents in tests
    // don't register as active pointers, so the capture call can
    // throw — drag state is set unconditionally so the no-capture
    // path still works (pointermove/up are also bound on the lane).
    try { lane.setPointerCapture(e.pointerId); } catch { /* ok */ }
    velDrag = { pitch, startTick, lane, pointerId: e.pointerId };
    // Immediate update so a tap (no drag) also sets the velocity.
    applyVelDrag(e.clientY);
  }

  function onVelLanePointerMove(e: PointerEvent) {
    if (!velDrag || e.pointerId !== velDrag.pointerId) return;
    applyVelDrag(e.clientY);
  }

  function onVelLanePointerUp(e: PointerEvent) {
    if (!velDrag || e.pointerId !== velDrag.pointerId) return;
    if (velDrag.lane.hasPointerCapture(e.pointerId)) {
      velDrag.lane.releasePointerCapture(e.pointerId);
    }
    velDrag = null;
  }

  function applyVelDrag(clientY: number) {
    if (!velDrag) return;
    const clip = getPianoRollClipForTrack(project, trackIdx);
    if (!clip) return;
    const v = yToVelocity(clientY, velDrag.lane);
    setPianoRollNoteVelocity(project, clip, velDrag.pitch, velDrag.startTick, v);
  }

  $effect(() => {
    const idx = trackIdx;
    const clip = getPianoRollClipForTrack(project, idx);
    if (!clip) {
      notes = [];
      clipLengthTicks = STEPS_PER_CLIP * STEP_TICKS;
      return;
    }
    notes = readPianoRollNotes(clip);
    clipLengthTicks = snapshotClipLength();
    const onChange = () => {
      notes = readPianoRollNotes(clip);
      clipLengthTicks = snapshotClipLength();
    };
    clip.observeDeep(onChange);
    return () => {
      clip.unobserveDeep(onChange);
    };
  });

  // Drive the column-highlight playhead from engine current_tick.
  // The grid scales to the clip's `lengthTicks`; the playhead
  // column wraps through that range so notes outside the
  // legacy 1-bar window stay reachable for multi-bar clips.
  $effect(() => {
    let cancelled = false;
    let raf = 0;
    const tick = async () => {
      if (cancelled) return;
      const t = await audio.debugRead('currentTick');
      const clipTicks = clipLengthTicks;
      playheadCol =
        t > 0 && clipTicks > 0
          ? Math.floor((t % clipTicks) / STEP_TICKS)
          : -1;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  });
</script>

<div class="wrap" class:drum-roll={pluginId === 'builtin:drumkit'}>
  <div class="roll">
    <div class="keys">
      {#each rowDefs as row (row.midi)}
        <div class="key" class:black={row.isAccent} title="MIDI {row.midi}">{row.label}</div>
      {/each}
    </div>
    <div
      class="grid"
      data-testid={`piano-grid-${trackIdx}`}
      style="
        grid-template-rows: repeat({rowDefs.length}, var(--row-h));
        grid-template-columns: repeat({cols}, var(--col-w));
      "
      onmouseleave={clearHoverBroadcast}
      role="presentation"
    >
      {#each rowDefs as row, r (row.midi)}
        {#each Array(cols) as _, c}
          {@const peerColor = peerCellColor(row.midi, c)}
          {@const covering = noteCovering(c, row.midi)}
          {@const hideOriginal = isMovingOriginalCell(c, row.midi)}
          {@const showOn = Boolean(covering) && !hideOriginal}
          {@const isNoteStart = showOn && covering?.startTick === c * STEP_TICKS}
          {@const inGhost = ghostFor(c, row.midi)}
          {@const ghostStart = inGhost && isGhostStart(c, row.midi)}
          <button
            class="cell"
            class:black-row={row.isAccent}
            class:beat={c % 4 === 0}
            class:on={showOn}
            class:note-start={isNoteStart || ghostStart}
            class:ghost={inGhost}
            class:playhead={c === playheadCol}
            class:peer-hover={peerColor != null}
            style="grid-row: {r + 1}; grid-column: {c + 1};{peerColor ? ` --peer-color: ${peerColor};` : ''}"
            data-testid={`piano-cell-${row.midi}-${c}`}
            onpointerdown={(e) => onCellPointerDown(e, c, row.midi)}
            onpointerenter={() => onCellPointerEnter(c, row.midi)}
            onpointerup={onCellPointerUp}
            onpointercancel={() => { drag = null; }}
            aria-label={`${row.label} ${c + 1}`}
          ></button>
        {/each}
      {/each}
    </div>

    <!--
      Phase-10 M2c — per-note velocity lane. One vertical bar per note
      at its `startTick` column; bar height encodes velocity in
      [VELOCITY_MIN, VELOCITY_MAX]. Drag a bar's top up/down to set
      that note's velocity. Multi-note overlap on the same column
      stacks visually but each bar stays independently grabbable.
    -->
    <div class="vel-label" aria-hidden="true">Vel</div>
    <div
      class="vel-lane"
      data-testid={`piano-velocity-lane-${trackIdx}`}
      style="grid-template-columns: repeat({cols}, var(--col-w));"
      onpointermove={onVelLanePointerMove}
      onpointerup={onVelLanePointerUp}
      onpointercancel={onVelLanePointerUp}
      role="presentation"
    >
      {#each notes as n (`${n.pitch}:${n.startTick}`)}
        {@const col = n.startTick / STEP_TICKS}
        {@const heightPct = ((n.velocity - VELOCITY_MIN) / (VELOCITY_MAX - VELOCITY_MIN)) * 100}
        <button
          class="vel-bar"
          class:playhead={col === playheadCol}
          style="grid-column: {col + 1}; height: {Math.max(4, heightPct)}%;"
          data-testid={`piano-vel-bar-${n.pitch}-${n.startTick}`}
          data-velocity={n.velocity}
          onpointerdown={(e) => onVelBarPointerDown(e, n.pitch, n.startTick)}
          title={`${n.velocity}`}
          aria-label={`Velocity for note ${n.pitch} at tick ${n.startTick}: ${n.velocity}`}
        ></button>
      {/each}
    </div>
  </div>
</div>

<style>
  .wrap {
    font-family: system-ui, sans-serif;
    color: #ddd;
  }
  .roll {
    /* Shared column / row sizing — the note grid and the velocity
       lane both reference these so their columns line up vertically. */
    --row-h: 22px;
    --col-w: 36px;
    display: grid;
    grid-template-columns: 32px auto;
    grid-template-rows: auto auto;
    gap: 4px;
    overflow-x: auto;
    max-width: 100%;
  }
  .drum-roll .roll {
    --row-h: 32px;
    --col-w: 28px;
  }
  /* Drum view needs more room for "Closed Hat" / "Open Hat" labels
     and benefits from taller rows since there's only 5 of them. */
  .drum-roll .roll {
    grid-template-columns: 80px 1fr;
  }
  .drum-roll .key {
    font-size: 10px;
    background: #20232a;
    color: #c8ccd4;
    border-bottom: 1px solid #1a1c21;
    padding: 0 6px;
    text-transform: none;
  }
  .keys {
    display: grid;
    grid-auto-rows: 1fr;
  }
  .key {
    font-size: 9px;
    line-height: 1;
    padding: 1px 2px;
    color: #666;
    background: #eee;
    border-bottom: 1px solid #ccc;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .key.black {
    background: #444;
    color: #aaa;
  }
  .grid {
    /* Cells size from the shared `--row-h` / `--col-w` declared on
       `.roll`; the outer container scrolls horizontally if the
       column count exceeds the canvas. */
    display: grid;
    background: #222;
    border: 1px solid #333;
  }
  .cell {
    appearance: none;
    border: none;
    background: transparent;
    border-right: 1px solid #2a2a2a;
    border-bottom: 1px solid #2a2a2a;
    cursor: pointer;
    padding: 0;
  }
  .cell.black-row {
    background: #1c1c1c;
  }
  .cell.beat {
    border-left: 1px solid #444;
  }
  .cell.on {
    background: #ff8c00;
  }
  /* Phase-10 M2a — the first cell of a multi-step note gets a left
     border so adjacent notes on the same row don't blur into one
     undifferentiated bar. */
  .cell.note-start {
    border-left: 2px solid #cc6a00;
  }
  /* Drag-in-progress ghost — translucent overlay so users see what
     they'll commit before they release. */
  .cell.ghost {
    background: rgba(255, 140, 0, 0.35);
  }
  .cell.ghost.on { background: rgba(255, 140, 0, 0.7); }
  .cell.playhead {
    box-shadow: inset 0 0 0 2px #ffd84a;
  }
  .cell.on.playhead {
    background: #ffaa33;
  }
  /* Phase-9 M4 — ghost outline in the peer's color when a remote
     peer is hovering this cell. */
  .cell.peer-hover {
    box-shadow: inset 0 0 0 2px var(--peer-color, var(--accent-hi));
  }
  /* Phase-10 M2c — velocity lane.
     Each `.vel-bar` sits at the bottom of its grid column, growing
     upward as velocity increases. The lane container is a CSS grid
     mirroring the note grid's column layout so bars line up
     vertically with their notes. */
  .vel-label {
    color: #888;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    padding: 0 4px 2px 0;
  }
  .vel-lane {
    height: 56px;
    display: grid;
    align-items: end;
    background: #1a1c21;
    border: 1px solid #333;
    position: relative;
  }
  .vel-bar {
    appearance: none;
    border: none;
    background: #ff8c00;
    /* Reduce the visible width so adjacent-column bars don't touch. */
    width: calc(var(--col-w) - 6px);
    justify-self: center;
    cursor: ns-resize;
    padding: 0;
    border-radius: 2px 2px 0 0;
    align-self: end;
    touch-action: none;
  }
  .vel-bar:hover {
    background: #ffa733;
  }
  .vel-bar.playhead {
    background: #ffd84a;
  }
</style>
