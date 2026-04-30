<script lang="ts">
  import { onMount } from 'svelte';
  import * as audio from './audio';

  const STEPS = 16;
  const LOW = 48; // C3
  const HIGH = 72; // C5 inclusive
  const NOTES = HIGH - LOW + 1; // 25 rows

  // top row = HIGH, bottom row = LOW (piano-roll orientation)
  const rows = Array.from({ length: NOTES }, (_, r) => HIGH - r);

  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const isBlack = (m: number) => BLACK.has(((m % 12) + 12) % 12);
  const name = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

  // steps[i] = bitmask of active notes; bit k = MIDI note LOW + k
  let steps = $state<number[]>(Array(STEPS).fill(0));
  let bpm = $state(120);
  let playing = $state(false);
  let playhead = $state(-1);
  let waveform = $state<audio.Waveform>('sine');
  const WAVEFORMS: audio.Waveform[] = ['sine', 'saw', 'square'];

  const bitFor = (midi: number) => 1 << (midi - LOW);
  const hasNote = (mask: number, midi: number) => ((mask >>> (midi - LOW)) & 1) === 1;

  function encodeSteps(): string {
    return steps.map((m) => (m >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function decodeSteps(s: string): number[] | null {
    if (s.length !== STEPS * 8) return null;
    const out: number[] = [];
    for (let i = 0; i < STEPS; i++) {
      const v = parseInt(s.slice(i * 8, i * 8 + 8), 16);
      if (Number.isNaN(v)) return null;
      out.push(v >>> 0);
    }
    return out;
  }

  function parseHash() {
    const h = new URLSearchParams(window.location.hash.slice(1));
    const s = h.get('s');
    const b = h.get('bpm');
    const w = h.get('w');
    if (s) {
      const decoded = decodeSteps(s);
      if (decoded) steps = decoded;
    }
    if (b !== null) bpm = Math.max(20, Math.min(300, +b));
    if (w && (WAVEFORMS as string[]).includes(w)) waveform = w as audio.Waveform;
  }

  function writeHash() {
    const h = new URLSearchParams();
    h.set('s', encodeSteps());
    h.set('bpm', String(bpm));
    h.set('w', waveform);
    const next = '#' + h.toString();
    if (next !== window.location.hash) history.replaceState(null, '', next);
  }

  onMount(() => {
    parseHash();
    // push full pattern to audio engine once ready
    for (let i = 0; i < STEPS; i++) void audio.setStepMask(i, steps[i]);
    audio.onStep((s) => { playhead = s; });
    window.addEventListener('hashchange', parseHash);
    return () => window.removeEventListener('hashchange', parseHash);
  });

  function setCell(col: number, midi: number) {
    // toggle just this note — polyphonic: other notes in the column are untouched.
    const next = (steps[col] ^ bitFor(midi)) >>> 0;
    steps[col] = next;
    void audio.setStepMask(col, next);
    writeHash();
  }

  async function togglePlay() {
    if (playing) {
      await audio.stop();
      playing = false;
    } else {
      for (let i = 0; i < STEPS; i++) await audio.setStepMask(i, steps[i]);
      await audio.setBpm(bpm);
      await audio.play();
      playing = true;
    }
  }

  $effect(() => { void audio.setBpm(bpm); writeHash(); });
  $effect(() => { void audio.setWaveform(waveform); writeHash(); });
</script>

<div class="wrap">
  <h1>wasm daw</h1>

  <div class="controls">
    <button class="play" onclick={togglePlay}>{playing ? 'stop' : 'play'}</button>
    <label>bpm <input type="number" min="20" max="300" bind:value={bpm} /></label>
    <label>wave
      <select bind:value={waveform}>
        {#each WAVEFORMS as w}
          <option value={w}>{w}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="roll">
    <div class="keys">
      {#each rows as midi}
        <div class="key" class:black={isBlack(midi)}>{name(midi)}</div>
      {/each}
    </div>
    <div class="grid" style="grid-template-rows: repeat({NOTES}, 1fr); grid-template-columns: repeat({STEPS}, 1fr);">
      {#each rows as midi, r}
        {#each Array(STEPS) as _, c}
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

  <p class="hint">click cells to toggle notes — stack multiple notes per column for chords. URL carries the pattern.</p>
</div>

<style>
  .wrap {
    font-family: system-ui, sans-serif;
    max-width: 960px;
    margin: 2rem auto;
    padding: 0 1rem;
    color: #eee;
  }
  h1 { font-weight: 500; letter-spacing: -0.02em; }
  .controls {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .controls label {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.9rem;
    color: #aaa;
  }
  .controls input,
  .controls select {
    padding: 0.35rem 0.5rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    color: #eee;
    font: inherit;
  }
  .controls input { width: 5.5rem; }
  .play {
    padding: 0.5rem 1.2rem;
    background: #2563eb;
    color: white;
    border: none;
    border-radius: 4px;
    font: inherit;
    cursor: pointer;
  }
  .play:hover { background: #1d4ed8; }

  .roll {
    display: grid;
    grid-template-columns: 54px 1fr;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    overflow: hidden;
  }
  .keys {
    display: grid;
    grid-template-rows: repeat(25, 1fr);
    background: #111;
  }
  .key {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 6px;
    font-size: 0.65rem;
    color: #888;
    background: #f4f4f4;
    color: #333;
    border-bottom: 1px solid #d0d0d0;
    height: 22px;
  }
  .key.black {
    background: #222;
    color: #777;
    border-bottom-color: #111;
  }
  .grid {
    display: grid;
    gap: 0;
    background: #0a0a0a;
  }
  .cell {
    height: 22px;
    background: #161616;
    border: none;
    border-right: 1px solid #0a0a0a;
    border-bottom: 1px solid #0a0a0a;
    cursor: pointer;
    padding: 0;
  }
  .cell.black-row { background: #0e0e0e; }
  .cell.beat { border-left: 1px solid #2a2a2a; }
  .cell:hover { background: #1f1f1f; }
  .cell.on {
    background: #2563eb;
  }
  .cell.playhead { background: #1f1f1f; }
  .cell.black-row.playhead { background: #191919; }
  .cell.on.playhead {
    background: #60a5fa;
    box-shadow: 0 0 0 1px #93c5fd inset;
  }
  .hint { color: #666; font-size: 0.8rem; margin-top: 1rem; }
</style>
