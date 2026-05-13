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

  const { project, trackIdx }: { project: Project; trackIdx: number } = $props();

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

  function noteAt(col: number, midi: number): PianoRollNote | null {
    const tick = col * STEP_TICKS;
    return notes.find((n) => n.pitch === midi && n.startTick === tick) ?? null;
  }

  function toggleCell(col: number, midi: number) {
    const clip = getPianoRollClipForTrack(project, trackIdx);
    if (!clip) return;
    const tick = col * STEP_TICKS;
    if (noteAt(col, midi)) {
      removePianoRollNoteAt(project, clip, midi, tick);
    } else {
      addPianoRollNote(project, clip, {
        pitch: midi,
        velocity: 100,
        startTick: tick,
        lengthTicks: STEP_TICKS,
      });
    }
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
    >
      {#each rowDefs as row, r (row.midi)}
        {#each Array(cols) as _, c}
          <button
            class="cell"
            class:black-row={row.isAccent}
            class:beat={c % 4 === 0}
            class:on={Boolean(noteAt(c, row.midi))}
            class:playhead={c === playheadCol}
            style="grid-row: {r + 1}; grid-column: {c + 1};"
            data-testid={`piano-cell-${row.midi}-${c}`}
            onclick={() => toggleCell(c, row.midi)}
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
  .cell.playhead {
    box-shadow: inset 0 0 0 2px #ffd84a;
  }
  .cell.on.playhead {
    background: #ffaa33;
  }
</style>
