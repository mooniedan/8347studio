<script lang="ts">
  import { onDestroy } from 'svelte';
  import Sequencer from './lib/Sequencer.svelte';
  import TrackList from './lib/TrackList.svelte';
  import Mixer from './lib/Mixer.svelte';
  import PluginPanel from './lib/PluginPanel.svelte';
  import PianoRoll from './lib/PianoRoll.svelte';
  import {
    createProject,
    addSubtractiveTrack,
    getTrackPluginId,
    type Project,
  } from './lib/project';
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

  const ready = createProject().then(async (p) => {
    project = p;
    exposeDebugHandle(p);
    const { ring } = await audio.ensureReady();
    bridge = attachBridge(p, { ring, postRebuild: audio.postRebuild });

    // M1: route every incoming MIDI message to the currently selected
    // track. M2 will swap to the armed track.
    midi = createMidiInput({
      noteOn: (pitch, velocity) => bridge!.noteOn(selectedTrackIdx, pitch, velocity),
      noteOff: (pitch) => bridge!.noteOff(selectedTrackIdx, pitch),
      cc: (cc, value) => bridge!.midiCc(selectedTrackIdx, cc, value),
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
          <PluginPanel {project} trackIdx={selectedTrackIdx} />
        </div>
      {:else}
        <Sequencer {project} {bridge} trackIdx={selectedTrackIdx} />
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
  .synth-stack {
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
