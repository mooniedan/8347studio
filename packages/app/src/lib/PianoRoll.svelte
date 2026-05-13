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
  // Column index (0..STEPS_PER_CLIP-1) currently under the playhead,
  // computed from the engine's current_tick mod the visible bar.
  // -1 = transport stopped / not playing.
  let playheadCol = $state(-1);

  function snapshotNotes(): PianoRollNote[] {
    const clip = getPianoRollClipForTrack(project, trackIdx);
    return clip ? readPianoRollNotes(clip) : [];
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
      return;
    }
    notes = readPianoRollNotes(clip);
    const onChange = () => {
      notes = readPianoRollNotes(clip);
    };
    clip.observeDeep(onChange);
    return () => {
      clip.unobserveDeep(onChange);
    };
  });

  // Drive the column-highlight playhead from engine current_tick.
  // The grid shows STEPS_PER_CLIP columns of one bar; map any tick
  // to that bar via `mod (STEPS_PER_CLIP × STEP_TICKS)`. The poll
  // is animation-frame paced and only runs while playing.
  $effect(() => {
    const BAR_TICKS = STEPS_PER_CLIP * STEP_TICKS;
    let cancelled = false;
    let raf = 0;
    const tick = async () => {
      if (cancelled) return;
      const t = await audio.debugRead('currentTick');
      // current_tick freezes at 0 when stopped; treat that as no playhead.
      playheadCol = t > 0 ? Math.floor((t % BAR_TICKS) / STEP_TICKS) : -1;
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
      style="grid-template-rows: repeat({rowDefs.length}, 1fr); grid-template-columns: repeat({STEPS_PER_CLIP}, 1fr);"
    >
      {#each rowDefs as row, r (row.midi)}
        {#each Array(STEPS_PER_CLIP) as _, c}
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
    grid-template-columns: 32px 1fr;
    gap: 4px;
  }
  /* Drum view needs more room for "Closed Hat" / "Open Hat" labels
     and benefits from taller rows since there's only 5 of them. */
  .drum-roll .roll {
    grid-template-columns: 80px 1fr;
  }
  .drum-roll .grid {
    aspect-ratio: 16 / 5;
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
    display: grid;
    width: 640px;
    aspect-ratio: 16 / 25;
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
  .cell.playhead {
    box-shadow: inset 0 0 0 2px #ffd84a;
  }
  .cell.on.playhead {
    background: #ffaa33;
  }
</style>
