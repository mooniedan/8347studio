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
    getTrackInserts,
    getTrackSends,
    type Project,
  } from './project';
  import Meter from './ui/Meter.svelte';
  import Pill from './ui/Pill.svelte';

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
    inserts: { kind: string }[];
    sends: { targetTrackIdx: number }[];
  };

  let strips = $state<Strip[]>(untrack(() => snapshotStrips()));
  let masterGain = $state(untrack(() => getMasterGain(project)));
  let masterPeak = $state(0);
  let trackPeaks = $state<number[]>(untrack(() => new Array(strips.length).fill(0)));

  function gainToDb(g: number): string {
    if (g <= 0.0001) return '-∞';
    return (20 * Math.log10(g)).toFixed(1);
  }

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
        inserts: getTrackInserts(project, i).map((s) => ({ kind: s.kind })),
        sends: getTrackSends(project, i).map((s) => ({ targetTrackIdx: s.targetTrackIdx })),
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
      aria-label="Pop out mixer"
    >⤴</button>
  {/if}
  {#each strips as s, i (s.id)}
    <div
      class="strip"
      class:solo={s.solo}
      class:mute={s.mute}
      data-testid={`mixer-strip-${i}`}
    >
      <span class="stripe" style="background:{s.color}"></span>
      <span class="strip-name">{s.name}</span>

      <div class="inserts" data-testid={`mixer-inserts-${i}`}>
        {#each Array(4) as _, slot}
          {#if slot < s.inserts.length}
            <div class="insert filled" title={s.inserts[slot].kind}>
              <span class="dot" aria-hidden="true"></span>
              {s.inserts[slot].kind.replace(/^builtin:/, '')}
            </div>
          {:else}
            <div class="insert empty" aria-hidden="true">+</div>
          {/if}
        {/each}
      </div>

      <div class="sends" data-testid={`mixer-sends-${i}`}>
        {#if s.sends.length === 0}
          <div class="send-empty" aria-hidden="true">— sends —</div>
        {:else}
          {#each s.sends as snd, j (j)}
            <div class="send">→ T{snd.targetTrackIdx}</div>
          {/each}
        {/if}
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

      <div class="fader-row">
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
        <div class="meter-host" data-testid={`mixer-meter-${i}`}>
          <Meter
            level={Math.min(1, trackPeaks[i])}
            ariaLabel={`${s.name} meter`}
            height={120}
            width={8}
          />
        </div>
      </div>

      <div class="pill-row">
        <Pill
          kind="solo"
          active={s.solo}
          ariaLabel={`${s.name} solo`}
          testId={`mixer-solo-${i}`}
          onclick={() => setTrackSolo(project, i, !s.solo)}
        >S</Pill>
        <Pill
          kind="mute"
          active={s.mute}
          ariaLabel={`${s.name} mute`}
          testId={`mixer-mute-${i}`}
          onclick={() => setTrackMute(project, i, !s.mute)}
        >M</Pill>
      </div>

      <span class="db-readout num" data-testid={`mixer-db-${i}`}>
        {gainToDb(s.gain)}
      </span>
    </div>
  {/each}

  <div class="strip master" data-testid="mixer-master">
    <span class="stripe master-stripe"></span>
    <span class="strip-name">Master</span>

    <div class="inserts" data-testid="mixer-master-inserts" aria-label="Master inserts">
      <div class="insert empty" aria-hidden="true">limiter</div>
      <div class="insert empty" aria-hidden="true">+</div>
    </div>
    <div class="sends" aria-hidden="true"></div>
    <div class="pan" aria-hidden="true"></div>

    <div class="fader-row">
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
      <div class="meter-host" data-testid="mixer-master-meter">
        <Meter
          level={Math.min(1, masterPeak)}
          ariaLabel="Master meter"
          height={120}
          width={8}
        />
      </div>
    </div>

    <div class="pill-row" aria-hidden="true"></div>

    <span class="db-readout num" data-testid="mixer-master-db">
      {gainToDb(masterGain)}
    </span>
  </div>
</div>

<style>
  /* Phase 7 M4 — P4 mixer view. Channel strips matching the design:
     color stripe → name → insert slots → sends → pan → fader+meter
     → S/M pills → mono dB readout. Master strip is wider, has a
     limiter insert slot, sits on the right. */
  .mixer {
    display: flex;
    gap: var(--sp-2);
    padding: var(--sp-3);
    background: var(--bg-1);
    overflow-x: auto;
    align-items: stretch;
    min-height: 100%;
    font-family: var(--font-sans);
  }
  .popout {
    align-self: flex-start;
    background: transparent;
    border: 1px solid var(--line-1);
    color: var(--fg-2);
    padding: 2px 8px;
    font-size: var(--text-12);
    cursor: pointer;
    border-radius: var(--r-sm);
  }
  .popout:hover {
    color: var(--fg-0);
    border-color: var(--fg-3);
  }
  .strip {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
    width: 76px;
    padding: var(--sp-2);
    background: var(--bg-2);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    color: var(--fg-1);
    font-size: var(--text-10);
    flex-shrink: 0;
  }
  .strip.master {
    margin-left: var(--sp-3);
    width: 100px;
    border-color: var(--line-2);
  }

  .stripe {
    height: 4px;
    border-radius: var(--r-sm);
  }
  .master-stripe { background: var(--fg-3); }

  .strip-name {
    font-family: var(--font-sans);
    font-size: var(--text-11);
    font-weight: 500;
    color: var(--fg-0);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inserts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 48px;
  }
  .insert {
    height: 14px;
    padding: 0 4px;
    border: 1px solid var(--line-0);
    border-radius: 1px;
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--fg-2);
    background: var(--bg-1);
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    white-space: nowrap;
  }
  .insert.filled { color: var(--fg-0); border-color: var(--line-2); }
  .insert.empty {
    color: var(--fg-3);
    border-style: dashed;
    justify-content: center;
  }
  .insert .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }

  .sends {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 24px;
  }
  .send {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--fg-2);
    padding: 1px 4px;
    background: var(--bg-1);
    border: 1px solid var(--line-0);
    border-radius: 1px;
  }
  .send-empty {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--fg-3);
    text-align: center;
    padding: 4px 0;
    font-style: italic;
  }

  .pan {
    width: 100%;
    accent-color: var(--accent);
  }

  .fader-row {
    display: flex;
    align-items: stretch;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 124px;
  }
  .vfader {
    -webkit-appearance: slider-vertical;
    appearance: slider-vertical;
    writing-mode: bt-lr;
    width: 22px;
    height: 120px;
    accent-color: var(--accent);
  }
  .meter-host {
    display: flex;
    align-items: stretch;
  }

  .pill-row {
    display: flex;
    gap: 2px;
    justify-content: center;
    min-height: 18px;
  }
  .db-readout {
    text-align: center;
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-1);
    font-variant-numeric: tabular-nums;
  }
</style>
