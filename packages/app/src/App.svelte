<script lang="ts">
  import { onDestroy } from 'svelte';
  import Sequencer from './lib/Sequencer.svelte';
  import TrackList from './lib/TrackList.svelte';
  import Mixer from './lib/Mixer.svelte';
  import PluginPanel from './lib/PluginPanel.svelte';
  import PianoRoll from './lib/PianoRoll.svelte';
  import InsertSlots from './lib/InsertSlots.svelte';
  import SendList from './lib/SendList.svelte';
  import {
    createProject,
    addSubtractiveTrack,
    addBusTrack,
    addAutomationPoint,
    removeAutomationPoint,
    listAutomationLanes,
    getTrackPluginId,
    getArmedTrackIdx,
    getPianoRollClipForTrack,
    addPianoRollNote,
    readPianoRollNotes,
    getBpm,
    getMidiBinding,
    setMidiBinding,
    removeMidiBinding,
    setSynthParam,
    PPQ,
    STEP_TICKS,
    type Project,
    type AutoTargetKind,
  } from './lib/project';
  import {
    SUBTRACTIVE_DESCRIPTORS,
    descriptorById,
    scaleCcToParam,
  } from './lib/plugin-descriptors';
  import * as audio from './lib/audio';
  import { attachBridge, type Bridge } from './lib/engine-bridge';
  import { createPluginUiHost, type PluginHost } from './lib/plugin-ui';
  import { createMidiInput, type MidiInputController } from './lib/midi-input';

  // Hydrate the Y.Doc from IndexedDB before mounting the Sequencer.
  // Avoids the race where a fresh UI writes defaults that overwrite a
  // just-restored doc.
  let project = $state<Project | null>(null);
  let bridge = $state<Bridge | null>(null);
  let selectedTrackIdx = $state(0);
  // Tracks the selected track's plugin id so the panel re-mounts on
  // synth-track switch and disappears for non-synth tracks.
  let selectedPluginId = $derived.by(() => {
    if (!project) return null;
    return getTrackPluginId(project, selectedTrackIdx);
  });

  let midi: MidiInputController | null = null;
  let midiStatus = $state<'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported'>('idle');
  let midiDevices = $state<{ id: string; name: string }[]>([]);
  let selectedMidiId = $state<string | null>(null);

  // Live record (Phase 3 M3) — buffer in-flight notes by wall clock.
  // Convert to tick positions on commit using the current project BPM.
  type LiveNote = { pitch: number; velocity: number; onMs: number; offMs: number | null };
  let recording = $state(false);
  let recBuffer: LiveNote[] = [];
  let recStartMs = 0;

  // MIDI Learn (Phase 3 M4) — when active, the next CC# from a
  // hardware controller is captured into pendingCC and the user picks
  // a target param to bind. Learn-mode uses the panel's same control
  // grid; clicks while pendingCC != null commit the binding.
  let learnActive = $state(false);
  let learnPendingCC = $state<number | null>(null);

  const ready = createProject().then(async (p) => {
    project = p;
    exposeDebugHandle(p);
    const { ring } = await audio.ensureReady();
    bridge = attachBridge(p, { ring, postRebuild: audio.postRebuild });

    // Route incoming MIDI to the armed track. If nothing's armed,
    // fall back to the selected track so the panel works at-a-glance
    // (matches the M1 behavior).
    const routeIdx = () => {
      const armed = getArmedTrackIdx(p);
      return armed >= 0 ? armed : selectedTrackIdx;
    };
    midi = createMidiInput({
      noteOn: (pitch, velocity) => {
        bridge!.noteOn(routeIdx(), pitch, velocity);
        if (recording) {
          recBuffer.push({ pitch, velocity, onMs: performance.now(), offMs: null });
        }
      },
      noteOff: (pitch) => {
        bridge!.noteOff(routeIdx(), pitch);
        if (recording) {
          for (let i = recBuffer.length - 1; i >= 0; i--) {
            if (recBuffer[i].pitch === pitch && recBuffer[i].offMs == null) {
              recBuffer[i].offMs = performance.now();
              break;
            }
          }
        }
      },
      cc: (cc, value) => {
        // 1. Learn mode: capture the CC# and wait for the user to
        // click a target param. Don't propagate to the engine.
        if (learnActive) {
          learnPendingCC = cc;
          return;
        }
        // 2. Bound CC: drive the bound parameter via Y.Doc → SAB.
        const binding = getMidiBinding(p, cc);
        if (binding) {
          const pluginId = getTrackPluginId(p, binding.trackIdx);
          if (pluginId === 'builtin:subtractive') {
            const desc = descriptorById(SUBTRACTIVE_DESCRIPTORS, binding.paramId);
            if (desc) {
              setSynthParam(p, binding.trackIdx, binding.paramId, scaleCcToParam(desc, value));
            }
          }
          return;
        }
        // 3. Default: forward to the armed track's plugin so the
        // synth's own MidiCc handler (e.g. sustain pedal) sees it.
        bridge!.midiCc(routeIdx(), cc, value);
      },
    });
    const refreshMidi = () => {
      midiStatus = midi!.status;
      midiDevices = midi!.devices.map((d) => ({ id: d.id, name: d.name }));
      selectedMidiId = midi!.selectedDeviceId;
    };
    midi.subscribe(refreshMidi);
    refreshMidi();

    exposeBridgeHandle(bridge);
  });

  onDestroy(() => {
    midi?.destroy();
    bridge?.destroy();
    project?.destroy();
  });

  async function enableMidi() {
    if (!midi) return;
    await midi.request();
  }

  function onSelectMidiDevice(ev: Event) {
    if (!midi) return;
    const v = (ev.target as HTMLSelectElement).value;
    midi.selectedDeviceId = v === '__all__' ? null : v;
  }

  function toggleRecord() {
    if (!project) return;
    if (recording) {
      recording = false;
      commitRecording();
    } else {
      recBuffer = [];
      recStartMs = performance.now();
      recording = true;
    }
  }

  function toggleLearn() {
    learnActive = !learnActive;
    if (!learnActive) learnPendingCC = null;
  }

  function bindPendingCC(paramId: number) {
    if (!project || learnPendingCC == null) return;
    const trackIdx = selectedTrackIdx;
    if (trackIdx < 0) return;
    setMidiBinding(project, learnPendingCC, { trackIdx, paramId });
    learnPendingCC = null;
  }

  function unbindCC(cc: number) {
    if (!project) return;
    removeMidiBinding(project, cc);
  }

  function commitRecording() {
    if (!project) return;
    const armedIdx = getArmedTrackIdx(project);
    if (armedIdx < 0) {
      recBuffer = [];
      return;
    }
    const clip = getPianoRollClipForTrack(project, armedIdx);
    if (!clip) {
      recBuffer = [];
      return;
    }
    const bpm = getBpm(project);
    const ticksPerMs = (bpm * PPQ) / 60_000;
    const nowMs = performance.now();
    project.doc.transact(() => {
      for (const n of recBuffer) {
        const offMs = n.offMs ?? nowMs;
        const startTick = Math.max(0, Math.round((n.onMs - recStartMs) * ticksPerMs));
        const lengthTicks = Math.max(STEP_TICKS, Math.round((offMs - n.onMs) * ticksPerMs));
        addPianoRollNote(project!, clip, {
          pitch: n.pitch,
          velocity: n.velocity,
          startTick,
          lengthTicks,
        });
      }
    });
    recBuffer = [];
  }

  function exposeDebugHandle(p: Project) {
    Object.defineProperty(window, '__project', {
      configurable: true,
      get() {
        const firstClipId = p.clipById.keys().next().value as string | undefined;
        const firstClip = firstClipId ? p.clipById.get(firstClipId) : null;
        const trackId = p.tracks.length > 0 ? p.tracks.get(0) : null;
        const track = trackId ? p.trackById.get(trackId) : null;
        return {
          trackCount: p.tracks.length,
          clipCount: p.clipById.size,
          firstClipKind: firstClip?.get('kind') ?? null,
          firstTrackGain: track?.get('gain') ?? null,
        };
      },
    });
  }

  function exposeBridgeHandle(b: Bridge) {
    Object.defineProperty(window, '__bridge', {
      configurable: true,
      get() {
        return {
          rebuild: () => b.rebuild(),
          setTransport: (play: boolean) => b.setTransport(play),
          debugTrackGain: (track: number) => audio.debugRead('trackGain', track),
          debugTrackCount: () => audio.debugRead('trackCount'),
          debugMasterGain: () => audio.debugRead('masterGain'),
          debugCurrentTick: () => audio.debugRead('currentTick'),
          debugBpm: () => audio.debugRead('bpm'),
          debugTrackPeak: (track: number) => audio.debugRead('trackPeak', track),
          debugTrackParam: (track: number, paramId: number) =>
            audio.debugTrackParam(track, paramId),
          setParam: (track: number, paramId: number, value: number) =>
            b.setParam(track, paramId, value),
          addSubtractiveTrack: () => {
            if (!project) return -1;
            addSubtractiveTrack(project);
            return project.tracks.length - 1;
          },
          createPluginUiHost: (trackIdx: number): PluginHost | null => {
            if (!project) return null;
            return createPluginUiHost(project, trackIdx);
          },
          noteOn: (track: number, pitch: number, velocity: number) =>
            b.noteOn(track, pitch, velocity),
          noteOff: (track: number, pitch: number) => b.noteOff(track, pitch),
          midiCc: (track: number, cc: number, value: number) => b.midiCc(track, cc, value),
          /// Test backdoor: simulate a raw MIDI message on the input
          /// path. Bypasses requestMIDIAccess so Playwright can drive
          /// the decode logic.
          midiSimulate: (data: number[]) => midi?.simulate(data),
          isRecording: () => recording,
          /// Test affordance: dump the current note set on a track's
          /// PianoRoll clip. Lets the M3 spec assert the recording
          /// committed correctly without reaching into Y.Doc directly.
          getPianoRollNotes: (trackIdx: number) => {
            if (!project) return [];
            const clip = getPianoRollClipForTrack(project, trackIdx);
            return clip ? readPianoRollNotes(clip) : [];
          },
          // Phase-4 M4 automation backdoor. Phase-9 polish lays a real
          // graphical lane editor; today we expose the data path so
          // tests can exercise the engine evaluation.
          addAutomationPoint: (
            trackIdx: number,
            target: AutoTargetKind,
            slotIdx: number,
            paramId: number,
            tick: number,
            value: number,
          ) => {
            if (!project) return;
            addAutomationPoint(project, trackIdx, target, slotIdx, paramId, { tick, value });
          },
          removeAutomationPoint: (
            trackIdx: number,
            target: AutoTargetKind,
            slotIdx: number,
            paramId: number,
            pointIdx: number,
          ) => {
            if (!project) return;
            removeAutomationPoint(project, trackIdx, target, slotIdx, paramId, pointIdx);
          },
          listAutomationLanes: () => {
            if (!project) return [];
            return listAutomationLanes(project);
          },
        };
      },
    });
  }
</script>

{#await ready}
  <p class="loading">loading…</p>
{:then}
  {#if project && bridge}
    <h1>8347 Studio</h1>
    <div class="toolbar">
      <button
        class="add-synth"
        data-testid="add-synth-track"
        onclick={() => {
          if (!project) return;
          addSubtractiveTrack(project);
          selectedTrackIdx = project.tracks.length - 1;
        }}
      >+ Synth</button>

      <button
        class="add-synth"
        data-testid="add-bus-track"
        onclick={() => {
          if (!project) return;
          addBusTrack(project);
          selectedTrackIdx = project.tracks.length - 1;
        }}
      >+ Bus</button>

      <button
        class="record"
        class:recording
        data-testid="record"
        onclick={toggleRecord}
        aria-pressed={recording}
        title="Record live MIDI into the armed track's piano-roll clip"
      >
        <span class="record-dot"></span>
        {recording ? 'Recording' : 'Record'}
      </button>

      <button
        class="learn"
        class:active={learnActive}
        data-testid="midi-learn-toggle"
        onclick={toggleLearn}
        aria-pressed={learnActive}
        title="Bind hardware CCs to plugin parameters"
      >
        {#if learnActive && learnPendingCC != null}
          MIDI Learn — CC{learnPendingCC} → click a knob
        {:else if learnActive}
          MIDI Learn — wiggle a hardware knob
        {:else}
          MIDI Learn
        {/if}
      </button>

      <div class="midi-chip" data-testid="midi-chip">
        {#if midiStatus === 'unsupported'}
          <span class="midi-state">MIDI: unsupported</span>
        {:else if midiStatus === 'idle'}
          <button class="enable-midi" data-testid="enable-midi" onclick={enableMidi}
            >Enable MIDI</button
          >
        {:else if midiStatus === 'requesting'}
          <span class="midi-state">MIDI: requesting…</span>
        {:else if midiStatus === 'denied'}
          <span class="midi-state">MIDI: denied</span>
        {:else if midiDevices.length === 0}
          <span class="midi-state" data-testid="midi-no-devices">MIDI: no devices</span>
        {:else}
          <label class="midi-device">
            <span class="midi-state">MIDI</span>
            <select
              data-testid="midi-device"
              value={selectedMidiId ?? '__all__'}
              onchange={onSelectMidiDevice}
            >
              <option value="__all__">All devices</option>
              {#each midiDevices as d}
                <option value={d.id}>{d.name}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>
    </div>
    <div class="layout">
      <TrackList
        {project}
        selectedIdx={selectedTrackIdx}
        onSelect={(i) => (selectedTrackIdx = i)}
      />
      {#if selectedPluginId === 'builtin:subtractive'}
        <div class="synth-stack">
          <PianoRoll {project} trackIdx={selectedTrackIdx} />
          <PluginPanel
            {project}
            trackIdx={selectedTrackIdx}
            learnActive={learnActive}
            learnPendingCC={learnPendingCC}
            onBindParam={bindPendingCC}
            onUnbindCC={unbindCC}
          />
          <InsertSlots {project} trackIdx={selectedTrackIdx} />
          <SendList {project} trackIdx={selectedTrackIdx} />
        </div>
      {:else}
        <div class="track-view">
          <Sequencer {project} {bridge} trackIdx={selectedTrackIdx} />
          <InsertSlots {project} trackIdx={selectedTrackIdx} />
          <SendList {project} trackIdx={selectedTrackIdx} />
        </div>
      {/if}
    </div>
    <Mixer {project} />
  {/if}
{/await}

<style>
  :global(body) {
    background: #0d0d0d;
    color: #ddd;
    margin: 0;
  }
  h1 {
    font-family: system-ui, sans-serif;
    font-size: 14px;
    font-weight: 600;
    color: #ccc;
    padding: 8px 16px;
    margin: 0;
    border-bottom: 1px solid #2a2a2a;
  }
  .layout {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 16px;
    padding: 16px;
  }
  .synth-stack,
  .track-view {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid #1f1f1f;
  }

  .add-synth {
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 10px;
    font: 11px system-ui, sans-serif;
    cursor: pointer;
  }
  .add-synth:hover {
    background: #232323;
  }
  .record {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 10px;
    font: 11px system-ui, sans-serif;
    cursor: pointer;
  }
  .record:hover {
    background: #232323;
  }
  .record .record-dot {
    width: 8px;
    height: 8px;
    background: #555;
    border-radius: 50%;
  }
  .record.recording {
    border-color: #ff3a3a;
    color: #ff8585;
    background: #2a0e0e;
  }
  .record.recording .record-dot {
    background: #ff3a3a;
    animation: rec-pulse 1s infinite;
  }
  @keyframes rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .learn {
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 10px;
    font: 11px system-ui, sans-serif;
    cursor: pointer;
  }
  .learn:hover {
    background: #232323;
  }
  .learn.active {
    border-color: #4ad6ff;
    color: #4ad6ff;
    background: #0a1a22;
  }
  .midi-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #aaa;
    font: 11px system-ui, sans-serif;
    margin-left: auto;
  }
  .midi-chip select {
    background: #222;
    color: #ddd;
    border: 1px solid #333;
    padding: 2px 4px;
    font: inherit;
  }
  .enable-midi {
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 10px;
    font: inherit;
    cursor: pointer;
  }
  .midi-state {
    color: #888;
  }
  .loading {
    font-family: system-ui, sans-serif;
    color: #888;
    padding: 16px;
  }
</style>
