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

  // Phase 7 M3 — click-and-drag on the BPM input (vertical pointer
  // drag, shift = 0.1× sensitivity). The native number-input still
  // accepts typed values and wheel; this layer adds the drag.
  let bpmDrag: { y: number; start: number } | null = null;
  function onBpmPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (document.activeElement === e.currentTarget) return; // typing — don't hijack
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    bpmDrag = { y: e.clientY, start: bpm };
    e.preventDefault();
  }
  function onBpmPointerMove(e: PointerEvent) {
    if (!bpmDrag) return;
    const dy = bpmDrag.y - e.clientY;
    const step = e.shiftKey ? 0.1 : 1;
    const next = Math.max(20, Math.min(300, bpmDrag.start + Math.round(dy * step)));
    setBpm(project, next);
  }
  function onBpmPointerUp(e: PointerEvent) {
    if (!bpmDrag) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    bpmDrag = null;
  }
  function onBpmWheel(e: WheelEvent) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const step = e.shiftKey ? 0.1 : 1;
    const next = Math.max(20, Math.min(300, bpm + dir * step));
    setBpm(project, Math.round(next));
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
  <label class="bpm-label">
    <span class="bpm-cap">BPM</span>
    <input
      type="number"
      min="20"
      max="300"
      value={bpm}
      oninput={onBpmInput}
      data-testid="bpm-input"
      class="bpm-input num"
      onpointerdown={onBpmPointerDown}
      onpointermove={onBpmPointerMove}
      onpointerup={onBpmPointerUp}
      onwheel={onBpmWheel}
      title="Drag vertically (shift = fine), wheel, or type"
    />
  </label>
  <span class="tick-readout num" data-testid="current-tick">
    <span class="tick-cap">TICK</span>{currentTick}
  </span>
</div>

<style>
  /* Phase 7 M3 — Transport reskinned to design tokens. Lives inside
     the 48px top bar; horizontal flex, mono numerics for BPM + tick,
     accent green/red play button. */
  .transport {
    display: flex;
    gap: var(--sp-3);
    align-items: center;
    height: 100%;
    color: var(--fg-0);
    font-family: var(--font-sans);
    font-size: var(--text-12);
  }
  .transport label { display: flex; gap: 6px; align-items: center; color: var(--fg-2); }

  .transport input[type="number"] {
    font-family: var(--font-mono);
    font-size: var(--text-12);
    font-variant-numeric: tabular-nums;
    padding: 2px 4px;
    background: var(--bg-0);
    color: var(--fg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-inset);
    width: 64px;
    height: 22px;
  }
  .transport input[type="number"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .loop-bars input[type="number"] { width: 44px; }
  .loop-bars.disabled { color: var(--fg-3); }

  .bpm-label .bpm-cap,
  .tick-readout .tick-cap {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-3);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-right: 6px;
  }
  .bpm-input { cursor: ns-resize; }

  .tick-readout {
    color: var(--fg-1);
    font-family: var(--font-mono);
    font-size: var(--text-11);
    font-variant-numeric: tabular-nums;
    padding: 0 var(--sp-2);
  }

  button.play {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 var(--sp-3);
    font-family: var(--font-sans);
    font-size: var(--text-11);
    font-weight: 600;
    color: #0c1108;
    background: linear-gradient(180deg, #6cf06c 0%, #2ec92e 100%);
    border: 1px solid #1f8f1f;
    border-radius: var(--r-sm);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      0 1px 2px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    height: 26px;
  }
  button.play:hover { filter: brightness(1.08); }
  button.play:active {
    transform: translateY(0.5px);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
  }
  button.play.playing {
    color: var(--accent-fg);
    background: linear-gradient(180deg, var(--accent-hi), var(--accent), var(--accent-lo));
    border-color: var(--accent-lo);
  }
  .play-icon { font-size: 13px; line-height: 1; }
  .play-label { font-size: var(--text-10); }
</style>
