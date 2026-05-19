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

  /// Phase-10 M2a — drag-create state. `dragStart` flips to non-null
  /// on pointerdown over an empty cell; `dragEnd` tracks the last
  /// pointer-moved column so the ghost preview spans [start, end].
  /// pointerup commits a note with the resulting length (or toggles
  /// when the pointer never moved off the start cell).
  let dragStart = $state<{ col: number; midi: number } | null>(null);
  let dragEnd = $state<{ col: number; midi: number } | null>(null);

  function dragSpan(): { startCol: number; endCol: number } | null {
    if (!dragStart || !dragEnd) return null;
    if (dragStart.midi !== dragEnd.midi) return { startCol: dragStart.col, endCol: dragStart.col };
    const lo = Math.min(dragStart.col, dragEnd.col);
    const hi = Math.max(dragStart.col, dragEnd.col);
    return { startCol: lo, endCol: hi };
  }

  /// True if a tentative drag-ghost covers `(col, midi)`. Drives the
  /// translucent overlay so users see what they'll commit.
  function inDragGhost(col: number, midi: number): boolean {
    if (!dragStart) return false;
    if (midi !== dragStart.midi) return false;
    const span = dragSpan();
    if (!span) return false;
    return col >= span.startCol && col <= span.endCol;
  }

  function onCellPointerDown(e: PointerEvent, col: number, midi: number) {
    if (e.button !== 0) return;
    const existing = noteCovering(col, midi);
    if (existing) {
      // Click on an existing note — schedule a remove on pointerup
      // (don't remove immediately so future drag-move work can
      // distinguish click from drag). For M2a we treat any click on
      // an existing note as a remove.
      dragStart = { col, midi };
      dragEnd = { col, midi };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    dragStart = { col, midi };
    dragEnd = { col, midi };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onCellPointerEnter(col: number, midi: number) {
    if (!dragStart) {
      broadcastHover(col, midi);
      return;
    }
    // Constrain the drag to the original pitch row — multi-row
    // drags would imply pitch-shifting in the middle of a draw,
    // which is more confusing than useful.
    dragEnd = { col, midi: dragStart.midi };
  }

  function onCellPointerUp(e: PointerEvent) {
    if (!dragStart || !dragEnd) {
      dragStart = null;
      dragEnd = null;
      return;
    }
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
    const span = dragSpan();
    const start = dragStart;
    const end = dragEnd;
    dragStart = null;
    dragEnd = null;
    if (!span) return;
    commitDrag(start, end, span);
  }

  function commitDrag(
    start: { col: number; midi: number },
    end: { col: number; midi: number },
    span: { startCol: number; endCol: number },
  ): void {
    const clip = getPianoRollClipForTrack(project, trackIdx);
    if (!clip) return;
    // A drag that never left the start cell is a tap. If the cell
    // is empty, add a 1-step note (legacy behaviour); if it's
    // already occupied, remove the covering note.
    if (start.col === end.col) {
      const existing = noteCovering(start.col, start.midi);
      if (existing) {
        removePianoRollNoteAt(project, clip, start.midi, existing.startTick);
      } else {
        addPianoRollNote(project, clip, {
          pitch: start.midi,
          velocity: 100,
          startTick: start.col * STEP_TICKS,
          lengthTicks: STEP_TICKS,
        });
      }
      return;
    }
    // Multi-column drag: replace any covering note at the start
    // column with a fresh note that spans [startCol, endCol].
    const startTick = span.startCol * STEP_TICKS;
    const lengthTicks = (span.endCol - span.startCol + 1) * STEP_TICKS;
    const covering = noteCovering(span.startCol, start.midi);
    if (covering) {
      removePianoRollNoteAt(project, clip, start.midi, covering.startTick);
    }
    addPianoRollNote(project, clip, {
      pitch: start.midi,
      velocity: 100,
      startTick,
      lengthTicks,
    });
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
          {@const isNoteStart = covering?.startTick === c * STEP_TICKS}
          <button
            class="cell"
            class:black-row={row.isAccent}
            class:beat={c % 4 === 0}
            class:on={Boolean(covering)}
            class:note-start={isNoteStart}
            class:ghost={inDragGhost(c, row.midi)}
            class:playhead={c === playheadCol}
            class:peer-hover={peerColor != null}
            style="grid-row: {r + 1}; grid-column: {c + 1};{peerColor ? ` --peer-color: ${peerColor};` : ''}"
            data-testid={`piano-cell-${row.midi}-${c}`}
            onpointerdown={(e) => onCellPointerDown(e, c, row.midi)}
            onpointerenter={() => onCellPointerEnter(c, row.midi)}
            onpointerup={onCellPointerUp}
            onpointercancel={() => { dragStart = null; dragEnd = null; }}
            aria-label={`${row.label} ${c + 1}`}
          ></button>
        {/each}
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
    display: grid;
    grid-template-columns: 32px auto;
    gap: 4px;
    overflow-x: auto;
    max-width: 100%;
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
    /* Phase-8 follow-up — cells are sized explicitly so the grid
       scales horizontally with the clip length without crushing
       vertically. Outer `.roll` scrolls if content exceeds the
       canvas width. */
    --row-h: 22px;
    --col-w: 36px;
    display: grid;
    background: #222;
    border: 1px solid #333;
  }
  .drum-roll .grid {
    --row-h: 32px;
    --col-w: 28px;
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
</style>
