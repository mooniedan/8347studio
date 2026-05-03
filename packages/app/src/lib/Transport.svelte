<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as audio from './audio';
  import {
    STEP_TICKS,
    STEPS_PER_CLIP,
    getBpm,
    setBpm,
    getLoopRegion,
    setLoopRegion,
    getStepSeqClipForTrack,
    readSteps,
    type Project,
  } from './project';

  // Global transport — play/stop, BPM, loop region, current-tick
  // readout. Lives at the top of the app so it stays mounted as the
  // user switches between track types (Subtractive lead, StepSeq bass,
  // Bus, Audio). Per-track playhead animations live in their own
  // track-view components.
  const { project }: { project: Project } = $props();

  const TICKS_PER_BAR = STEPS_PER_CLIP * STEP_TICKS;

  let bpm = $state(untrack(() => getBpm(project)));
  let playing = $state(false);
  let currentTick = $state(0);

  const initialLoop = untrack(() => getLoopRegion(project));
  let loopEnabled = $state(initialLoop != null);
  const initialStartBar = initialLoop
    ? Math.floor(initialLoop.startTick / TICKS_PER_BAR) + 1
    : 1;
  let loopStartBar = $state(initialStartBar);
  let loopEndBar = $state(
    initialLoop
      ? Math.max(initialStartBar, Math.ceil(initialLoop.endTick / TICKS_PER_BAR))
      : 4,
  );

  onMount(() => {
    const tempoObserver = () => { bpm = getBpm(project); };
    project.tempoMap.observeDeep(tempoObserver);
    const metaObserver = () => {
      const lr = getLoopRegion(project);
      loopEnabled = lr != null;
      if (lr) {
        loopStartBar = Math.floor(lr.startTick / TICKS_PER_BAR) + 1;
        loopEndBar = Math.max(loopStartBar, Math.ceil(lr.endTick / TICKS_PER_BAR));
      }
    };
    project.meta.observe(metaObserver);
    return () => {
      project.tempoMap.unobserveDeep(tempoObserver);
      project.meta.unobserve(metaObserver);
    };
  });

  async function togglePlay() {
    if (playing) {
      await audio.stop();
      playing = false;
    } else {
      // Push every StepSeq clip's pattern before starting so freshly-
      // added tracks start in sync without waiting for the next
      // snapshot rebuild to land.
      for (let t = 0; t < project.tracks.length; t++) {
        const c = getStepSeqClipForTrack(project, t);
        if (!c) continue;
        const masks = readSteps(c);
        for (let i = 0; i < STEPS_PER_CLIP; i++) {
          await audio.setStepMask(t, i, masks[i]);
        }
      }
      await audio.play();
      playing = true;
    }
  }

  function onBpmInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) setBpm(project, Math.max(20, Math.min(300, v)));
  }

  function commitLoop() {
    if (!loopEnabled) {
      setLoopRegion(project, null);
      return;
    }
    const start = Math.max(1, Math.floor(loopStartBar));
    const end = Math.max(start, Math.floor(loopEndBar));
    setLoopRegion(project, {
      startTick: (start - 1) * TICKS_PER_BAR,
      endTick: end * TICKS_PER_BAR,
    });
  }

  function onLoopToggle(e: Event) {
    loopEnabled = (e.target as HTMLInputElement).checked;
    commitLoop();
  }

  function onLoopStartInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v) || v < 1) return;
    loopStartBar = Math.floor(v);
    if (loopStartBar > loopEndBar) loopEndBar = loopStartBar;
    if (loopEnabled) commitLoop();
  }

  function onLoopEndInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v) || v < 1) return;
    loopEndBar = Math.floor(v);
    if (loopEndBar < loopStartBar) loopStartBar = loopEndBar;
    if (loopEnabled) commitLoop();
  }

  // Poll engine current_tick while playing so the readout stays live.
  $effect(() => {
    if (!playing) {
      currentTick = 0;
      return;
    }
    let cancelled = false;
    let raf = 0;
    const tick = async () => {
      if (cancelled) return;
      currentTick = await audio.debugRead('currentTick');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  });
</script>

<div class="transport" data-testid="transport">
  <button
    class="play"
    class:playing
    onclick={togglePlay}
    aria-label={playing ? 'Stop' : 'Play'}
    aria-pressed={playing}
  >
    <span class="play-icon" aria-hidden="true">{playing ? '■' : '▶'}</span>
    <span class="play-label">{playing ? 'stop' : 'play'}</span>
  </button>
  <label class="loop" data-testid="loop-toggle-label">
    <input
      type="checkbox"
      checked={loopEnabled}
      oninput={onLoopToggle}
      data-testid="loop-toggle"
    />
    loop
  </label>
  <label class="loop-bars" class:disabled={!loopEnabled}>
    bars
    <input
      type="number"
      min="1"
      max="999"
      value={loopStartBar}
      oninput={onLoopStartInput}
      disabled={!loopEnabled}
      data-testid="loop-start-bar"
    />
    –
    <input
      type="number"
      min="1"
      max="999"
      value={loopEndBar}
      oninput={onLoopEndInput}
      disabled={!loopEnabled}
      data-testid="loop-end-bar"
    />
  </label>
  <label>bpm
    <input
      type="number"
      min="20"
      max="300"
      value={bpm}
      oninput={onBpmInput}
      data-testid="bpm-input"
    />
  </label>
  <span class="tick-readout" data-testid="current-tick">tick {currentTick}</span>
</div>

<style>
  .transport {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 6px 10px;
    background: #161616;
    border: 1px solid #2a2a2a;
    color: #ddd;
    font: 12px system-ui, sans-serif;
    flex-wrap: wrap;
  }
  .transport label { display: flex; gap: 6px; align-items: center; }
  .transport input[type="number"] { font: inherit; padding: 2px 4px; width: 64px; }
  .loop-bars input[type="number"] { width: 44px; }
  .loop-bars.disabled { color: #666; }
  button.play {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 14px;
    font: inherit;
    font-weight: 600;
    color: #0c1108;
    background: linear-gradient(180deg, #6cf06c 0%, #2ec92e 100%);
    border: 1px solid #1f8f1f;
    border-radius: 4px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.25);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  button.play:hover {
    filter: brightness(1.08);
  }
  button.play:active {
    transform: translateY(1px);
    box-shadow: 0 0 0 rgba(0, 0, 0, 0), inset 0 1px 2px rgba(0, 0, 0, 0.3);
  }
  button.play.playing {
    color: #190a0a;
    background: linear-gradient(180deg, #ff7a7a 0%, #d62525 100%);
    border-color: #8e1414;
  }
  .play-icon { font-size: 13px; line-height: 1; }
  .play-label { font-size: 11px; }
  .tick-readout { color: #999; font: 11px ui-monospace, monospace; }
</style>
