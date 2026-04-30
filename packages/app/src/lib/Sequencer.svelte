<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as audio from './audio';
  import {
    LOW_MIDI,
    STEPS_PER_CLIP,
    WAVEFORMS,
    getFirstStepSeqClip,
    readSteps,
    writeStepNotes,
    getBpm,
    setBpm,
    getWaveform,
    setWaveform,
    getTrackGain,
    setTrackGain,
    type Project,
    type Waveform,
  } from './project';
  import type { Bridge } from './engine-bridge';

  const { project, bridge }: { project: Project; bridge: Bridge } = $props();

  const HIGH = 72; // C5 inclusive
  const NOTES = HIGH - LOW_MIDI + 1; // 25 rows
  const rows = Array.from({ length: NOTES }, (_, r) => HIGH - r);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = (m: number) => BLACK.has(((m % 12) + 12) % 12);
  const name = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

  const bitFor = (midi: number) => 1 << (midi - LOW_MIDI);
  const hasNote = (mask: number, midi: number) => ((mask >>> (midi - LOW_MIDI)) & 1) === 1;

  // Mirror Y.Doc state into reactive Svelte state. The Y.Doc remains the
  // source of truth; we resync on every observed change.
  let steps = $state<number[]>(untrack(() => readSteps(getFirstStepSeqClip(project)!)));
  let bpm = $state(untrack(() => getBpm(project)));
  let waveform = $state<Waveform>(untrack(() => getWaveform(project)));
  let trackGain = $state(untrack(() => getTrackGain(project, 0)));
  let playing = $state(false);
  let playhead = $state(-1);

  onMount(() => {
    const clip = getFirstStepSeqClip(project)!;
    const observer = () => { steps = readSteps(clip); };
    clip.observeDeep(observer);

    const tempoObserver = () => { bpm = getBpm(project); };
    project.tempoMap.observeDeep(tempoObserver);

    const trackObserver = () => {
      waveform = getWaveform(project);
      const next = getTrackGain(project, 0);
      if (next !== trackGain) {
        trackGain = next;
        bridge.setTrackGain(0, next);
      }
    };
    project.trackById.observeDeep(trackObserver);

    // Push full pattern to audio engine once ready.
    for (let i = 0; i < STEPS_PER_CLIP; i++) void audio.setStepMask(i, steps[i]);
    audio.onStep((s) => { playhead = s; });

    return () => {
      clip.unobserveDeep(observer);
      project.tempoMap.unobserveDeep(tempoObserver);
      project.trackById.unobserveDeep(trackObserver);
    };
  });

  function setCell(col: number, midi: number) {
    const clip = getFirstStepSeqClip(project);
    if (!clip) return;
    const next = (steps[col] ^ bitFor(midi)) >>> 0;
    writeStepNotes(clip, col, next);
    void audio.setStepMask(col, next);
  }

  async function togglePlay() {
    if (playing) {
      await audio.stop();
      playing = false;
    } else {
      for (let i = 0; i < STEPS_PER_CLIP; i++) await audio.setStepMask(i, steps[i]);
      await audio.setBpm(bpm);
      await audio.play();
      playing = true;
    }
  }

  function onBpmInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) setBpm(project, Math.max(20, Math.min(300, v)));
  }

  function onWaveformInput(e: Event) {
    const v = (e.target as HTMLSelectElement).value as Waveform;
    setWaveform(project, v);
  }

  function onTrackGainInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) setTrackGain(project, 0, Math.max(0, Math.min(1, v)));
  }

  $effect(() => { void audio.setBpm(bpm); });
  $effect(() => { void audio.setWaveform(waveform); });
</script>

<div class="wrap">
  <h1>wasm daw</h1>

  <div class="controls">
    <button class="play" onclick={togglePlay}>{playing ? 'stop' : 'play'}</button>
    <label>bpm <input type="number" min="20" max="300" value={bpm} oninput={onBpmInput} /></label>
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
    <div class="grid" style="grid-template-rows: repeat({NOTES}, 1fr); grid-template-columns: repeat({STEPS_PER_CLIP}, 1fr);">
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

  <p class="hint">click cells to toggle notes — stack multiple notes per column for chords.</p>
</div>

<style>
  .wrap {
    font-family: system-ui, sans-serif;
    padding: 16px;
    color: #ddd;
  }
  h1 { margin: 0 0 12px; font-size: 18px; font-weight: 600; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
  .controls label { display: flex; gap: 6px; align-items: center; font-size: 12px; }
  .controls input, .controls select { font: inherit; padding: 2px 4px; }
  button.play { padding: 4px 12px; }

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
