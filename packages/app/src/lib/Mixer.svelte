<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as audio from './audio';
  import {
    getMasterGain,
    setMasterGain,
    getTrackGain,
    setTrackGain,
    getTrackMute,
    setTrackMute,
    getTrackSolo,
    setTrackSolo,
    getTrackPan,
    setTrackPan,
    getTrackName,
    getTrackColor,
    type Project,
  } from './project';

  const {
    project,
    audioEnabled = true,
    onPopout,
  }: {
    project: Project;
    /// Set false in satellite popups (no audio engine in those windows).
    audioEnabled?: boolean;
    /// Optional pop-out hook — when wired, the mixer renders a "Pop
    /// out" button that opens a satellite window.
    onPopout?: () => void;
  } = $props();

  type Strip = {
    id: string;
    name: string;
    color: string;
    gain: number;
    pan: number;
    mute: boolean;
    solo: boolean;
  };

  let strips = $state<Strip[]>(untrack(() => snapshotStrips()));
  let masterGain = $state(untrack(() => getMasterGain(project)));
  let masterPeak = $state(0);
  let trackPeaks = $state<number[]>(untrack(() => new Array(strips.length).fill(0)));

  function snapshotStrips(): Strip[] {
    const out: Strip[] = [];
    for (let i = 0; i < project.tracks.length; i++) {
      const id = project.tracks.get(i);
      out.push({
        id,
        name: getTrackName(project, i),
        color: getTrackColor(project, i),
        gain: getTrackGain(project, i),
        pan: getTrackPan(project, i),
        mute: getTrackMute(project, i),
        solo: getTrackSolo(project, i),
      });
    }
    return out;
  }

  onMount(() => {
    const refresh = () => {
      strips = snapshotStrips();
      // Resize peak buffer if track count changed.
      if (trackPeaks.length !== strips.length) {
        trackPeaks = new Array(strips.length).fill(0);
      }
    };
    project.tracks.observe(refresh);
    project.trackById.observeDeep(refresh);
    const onMeta = () => { masterGain = getMasterGain(project); };
    project.meta.observe(onMeta);

    // Master meter: AnalyserNode tapped from the worklet output.
    let cleanupMaster: (() => void) | null = null;
    let masterRaf = 0;
    let trackRaf = 0;
    let trackCancelled = false;
    if (audioEnabled) {
      void audio.ensureReady().then(({ node }) => {
        const ctx = node.context as AudioContext;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        const buf = new Float32Array(analyser.fftSize);
        // Tap the worklet output before destination.
        node.connect(analyser);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let p = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i]);
            if (v > p) p = v;
          }
          masterPeak = p;
          masterRaf = requestAnimationFrame(tick);
        };
        masterRaf = requestAnimationFrame(tick);
        cleanupMaster = () => {
          cancelAnimationFrame(masterRaf);
          try { node.disconnect(analyser); } catch {/* ignore */}
        };
      });

      // Per-track meter: poll engine debug peak via the worklet RPC.
      const pollTrackPeaks = async () => {
        if (trackCancelled) return;
        const next: number[] = [];
        for (let i = 0; i < strips.length; i++) {
          next.push(await audio.debugRead('trackPeak', i));
        }
        trackPeaks = next;
        trackRaf = requestAnimationFrame(pollTrackPeaks);
      };
      trackRaf = requestAnimationFrame(pollTrackPeaks);
    }

    return () => {
      project.tracks.unobserve(refresh);
      project.trackById.unobserveDeep(refresh);
      project.meta.unobserve(onMeta);
      trackCancelled = true;
      cancelAnimationFrame(trackRaf);
      cleanupMaster?.();
    };
  });
</script>

<div class="mixer" data-testid="mixer">
  {#if onPopout}
    <button
      class="popout"
      data-testid="mixer-popout"
      onclick={() => onPopout?.()}
      title="Open the mixer in a separate window"
    >⤴</button>
  {/if}
  {#each strips as s, i (s.id)}
    <div class="strip" class:solo={s.solo} class:mute={s.mute} data-testid={`mixer-strip-${i}`}>
      <span class="stripe" style="background:{s.color}"></span>
      <span class="strip-name">{s.name}</span>
      <div class="meter" data-testid={`mixer-meter-${i}`}>
        <div class="meter-fill" style="height: {Math.min(100, trackPeaks[i] * 100)}%"></div>
      </div>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={s.gain}
        oninput={(e) => setTrackGain(project, i, Number((e.target as HTMLInputElement).value))}
        class="vfader"
        data-testid={`mixer-gain-${i}`}
        aria-label={`${s.name} gain`}
      />
      <div class="strip-buttons">
        <button
          class="btn"
          class:active={s.mute}
          onclick={() => setTrackMute(project, i, !s.mute)}
          data-testid={`mixer-mute-${i}`}
        >M</button>
        <button
          class="btn"
          class:active={s.solo}
          onclick={() => setTrackSolo(project, i, !s.solo)}
          data-testid={`mixer-solo-${i}`}
        >S</button>
      </div>
      <input
        type="range"
        min="-1"
        max="1"
        step="0.01"
        value={s.pan}
        oninput={(e) => setTrackPan(project, i, Number((e.target as HTMLInputElement).value))}
        class="pan"
        data-testid={`mixer-pan-${i}`}
        aria-label={`${s.name} pan`}
      />
    </div>
  {/each}

  <div class="strip master" data-testid="mixer-master">
    <span class="stripe master-stripe"></span>
    <span class="strip-name">Master</span>
    <div class="meter" data-testid="mixer-master-meter">
      <div class="meter-fill" style="height: {Math.min(100, masterPeak * 100)}%"></div>
    </div>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={masterGain}
      oninput={(e) => setMasterGain(project, Number((e.target as HTMLInputElement).value))}
      class="vfader"
      data-testid="mixer-master-gain"
      aria-label="master gain"
    />
  </div>
</div>

<style>
  .mixer {
    display: flex;
    gap: 4px;
    padding: 8px;
    background: #0f0f0f;
    border: 1px solid #2a2a2a;
    overflow-x: auto;
  }
  .popout {
    align-self: flex-start;
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #888;
    padding: 2px 8px;
    font: 12px system-ui, sans-serif;
    cursor: pointer;
  }
  .popout:hover {
    color: #ddd;
    border-color: #444;
  }
  .strip {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    width: 60px;
    padding: 4px;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    color: #ccc;
    font-family: system-ui, sans-serif;
    font-size: 10px;
  }
  .stripe {
    height: 4px;
    border-radius: 2px;
  }
  .master-stripe { background: #555; }
  .strip-name {
    font-size: 10px;
    text-align: center;
    color: #ccc;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meter {
    height: 80px;
    background: #0a0a0a;
    border: 1px solid #2a2a2a;
    position: relative;
    margin: 0 auto;
    width: 12px;
  }
  .meter-fill {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to top, #2c8, #cc4 60%, #f44 90%);
    transition: height 32ms linear;
  }
  .vfader {
    -webkit-appearance: slider-vertical;
    appearance: slider-vertical;
    writing-mode: bt-lr;
    width: 24px;
    height: 80px;
    margin: 0 auto;
  }
  .pan {
    width: 100%;
  }
  .strip-buttons {
    display: flex;
    gap: 2px;
    justify-content: center;
  }
  .btn {
    appearance: none;
    background: #222;
    color: #aaa;
    border: 1px solid #333;
    padding: 2px 6px;
    font: inherit;
    cursor: pointer;
  }
  .btn:hover { background: #2a2a2a; }
  .btn.active { background: #ff8c00; color: #0a0a0a; border-color: #ff8c00; }
  .strip.master {
    margin-left: 8px;
    border-color: #444;
  }
</style>
