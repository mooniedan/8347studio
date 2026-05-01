<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as audio from './audio';
  import {
    LOW_MIDI,
    STEP_TICKS,
    STEPS_PER_CLIP,
    type Project,
    type PianoRollNote,
    getPianoRollClipForTrack,
    readPianoRollNotes,
    addPianoRollNote,
    removePianoRollNoteAt,
  } from './project';

  const { project, trackIdx }: { project: Project; trackIdx: number } = $props();

  // C3..C5 inclusive, same range as the step grid for visual continuity.
  const HIGH = LOW_MIDI + 24; // 72 = C5
  const NOTES = HIGH - LOW_MIDI + 1;
  const rows = Array.from({ length: NOTES }, (_, r) => HIGH - r);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = (m: number) => BLACK.has(((m % 12) + 12) % 12);
  const name = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

  let notes = $state<PianoRollNote[]>(untrack(() => snapshotNotes()));
  let playing = $state(false);

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

  async function togglePlay() {
    if (playing) {
      await audio.stop();
      playing = false;
    } else {
      await audio.play();
      playing = true;
    }
  }
</script>

<div class="wrap">
  <div class="controls">
    <button class="play" onclick={togglePlay} data-testid="piano-play">
      {playing ? 'stop' : 'play'}
    </button>
  </div>
  <div class="roll">
    <div class="keys">
      {#each rows as midi}
        <div class="key" class:black={isBlack(midi)}>{name(midi)}</div>
      {/each}
    </div>
    <div
      class="grid"
      data-testid={`piano-grid-${trackIdx}`}
      style="grid-template-rows: repeat({NOTES}, 1fr); grid-template-columns: repeat({STEPS_PER_CLIP}, 1fr);"
    >
      {#each rows as midi, r}
        {#each Array(STEPS_PER_CLIP) as _, c}
          <button
            class="cell"
            class:black-row={isBlack(midi)}
            class:beat={c % 4 === 0}
            class:on={Boolean(noteAt(c, midi))}
            style="grid-row: {r + 1}; grid-column: {c + 1};"
            data-testid={`piano-cell-${midi}-${c}`}
            onclick={() => toggleCell(c, midi)}
            aria-label={`${name(midi)} ${c + 1}`}
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
  .controls {
    display: flex;
    gap: 12px;
    margin-bottom: 8px;
  }
  button.play {
    padding: 4px 12px;
  }
  .roll {
    display: grid;
    grid-template-columns: 32px 1fr;
    gap: 4px;
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
</style>
