<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as audio from './audio';
  import {
    LOW_MIDI,
    STEPS_PER_CLIP,
    WAVEFORMS,
    getStepSeqClipForTrack,
    readSteps,
    writeStepNotes,
    getWaveform,
    setWaveform,
    getTrackGain,
    setTrackGain,
    type Project,
    type Waveform,
  } from './project';
  const {
    project,
    trackIdx,
  }: { project: Project; trackIdx: number } = $props();

  const HIGH = 72; // C5 inclusive
  const NOTES = HIGH - LOW_MIDI + 1; // 25 rows
  const rows = Array.from({ length: NOTES }, (_, r) => HIGH - r);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = (m: number) => BLACK.has(((m % 12) + 12) % 12);
  const name = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

  const bitFor = (midi: number) => 1 << (midi - LOW_MIDI);
  const hasNote = (mask: number, midi: number) => ((mask >>> (midi - LOW_MIDI)) & 1) === 1;

  // Mirror Y.Doc state into reactive Svelte state, scoped to the
  // currently selected track. Resync on every observed change AND
  // when trackIdx changes.
  let steps = $state<number[]>(untrack(() => readClipSteps()));
  let waveform = $state<Waveform>(untrack(() => getWaveform(project, trackIdx)));
  let trackGain = $state(untrack(() => getTrackGain(project, trackIdx)));
  let playhead = $state(-1);

  function readClipSteps(): number[] {
    const clip = getStepSeqClipForTrack(project, trackIdx);
    return clip ? readSteps(clip) : Array<number>(STEPS_PER_CLIP).fill(0);
  }

  // (Re-)attach observers whenever the visible track changes.
  $effect(() => {
    const idx = trackIdx;
    const clip = getStepSeqClipForTrack(project, idx);
    if (!clip) return;
    steps = readSteps(clip);
    waveform = getWaveform(project, idx);
    trackGain = getTrackGain(project, idx);

    const stepObserver = () => { steps = readSteps(clip); };
    clip.observeDeep(stepObserver);

    const trackObserver = () => {
      waveform = getWaveform(project, idx);
      // Gain mirror — engine-bridge handles the SAB event itself when
      // the Y.Doc value changes; this just keeps the slider's display
      // in sync if the value moves from outside this component.
      trackGain = getTrackGain(project, idx);
    };
    project.trackById.observeDeep(trackObserver);

    return () => {
      clip.unobserveDeep(stepObserver);
      project.trackById.unobserveDeep(trackObserver);
    };
  });

  onMount(() => {
    audio.onStep((s) => { playhead = s; });
  });

  function setCell(col: number, midi: number) {
    const clip = getStepSeqClipForTrack(project, trackIdx);
    if (!clip) return;
    const next = (steps[col] ^ bitFor(midi)) >>> 0;
    writeStepNotes(clip, col, next);
    void audio.setStepMask(trackIdx, col, next);
  }

  function onWaveformInput(e: Event) {
    const v = (e.target as HTMLSelectElement).value as Waveform;
    setWaveform(project, v, trackIdx);
  }

  function onTrackGainInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) setTrackGain(project, trackIdx, Math.max(0, Math.min(1, v)));
  }

  $effect(() => { void audio.setWaveform(trackIdx, waveform); });
</script>

<div class="wrap">
  <div class="controls">
    <label>wave
      <select value={waveform} oninput={onWaveformInput}>
        {#each WAVEFORMS as w}
          <option value={w}>{w}</option>
        {/each}
      </select>
    </label>
    <label>gain
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={trackGain}
        oninput={onTrackGainInput}
        data-testid="track-gain"
      />
      <span class="gain-readout" data-testid="track-gain-readout">{trackGain.toFixed(2)}</span>
    </label>
  </div>

  <div class="roll">
    <div class="keys">
      {#each rows as midi}
        <div class="key" class:black={isBlack(midi)}>{name(midi)}</div>
      {/each}
    </div>
    <div class="grid" data-testid={`grid-${trackIdx}`} style="grid-template-rows: repeat({NOTES}, 1fr); grid-template-columns: repeat({STEPS_PER_CLIP}, 1fr);">
      {#each rows as midi, r}
        {#each Array(STEPS_PER_CLIP) as _, c}
          <button
            class="cell"
            class:black-row={isBlack(midi)}
            class:beat={c % 4 === 0}
            class:on={hasNote(steps[c], midi)}
            class:playhead={c === playhead}
            style="grid-row: {r + 1}; grid-column: {c + 1};"
            onclick={() => setCell(c, midi)}
            aria-label={`${name(midi)} step ${c + 1}`}
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
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .controls label { display: flex; gap: 6px; align-items: center; font-size: 12px; }
  .controls input, .controls select { font: inherit; padding: 2px 4px; }
  .gain-readout {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px;
    color: #888;
  }

  .roll { display: grid; grid-template-columns: 32px 1fr; gap: 4px; }
  .keys { display: grid; grid-auto-rows: 1fr; }
  .key {
    font-size: 9px; line-height: 1; padding: 1px 2px; color: #666;
    background: #eee; border-bottom: 1px solid #ccc;
    display: flex; align-items: center; justify-content: flex-end;
  }
  .key.black { background: #444; color: #aaa; }

  .grid {
    display: grid;
    width: 640px;
    aspect-ratio: 16 / 25;
    background: #222;
    border: 1px solid #333;
  }
  .cell {
    appearance: none; border: none; background: transparent;
    border-right: 1px solid #2a2a2a;
    border-bottom: 1px solid #2a2a2a;
    cursor: pointer; padding: 0;
  }
  .cell.black-row { background: #1c1c1c; }
  .cell.beat { border-left: 1px solid #444; }
  .cell.on { background: #ff8c00; }
  .cell.playhead { box-shadow: inset 0 0 0 1px #ff0; }
</style>
