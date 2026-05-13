<script lang="ts">
  import { onDestroy } from 'svelte';
  import Sequencer from './lib/Sequencer.svelte';
  import Transport from './lib/Transport.svelte';
  import TrackList from './lib/TrackList.svelte';
  import Mixer from './lib/Mixer.svelte';
  import PluginPanel from './lib/PluginPanel.svelte';
  import PianoRoll from './lib/PianoRoll.svelte';
  import InsertSlots from './lib/InsertSlots.svelte';
  import SendList from './lib/SendList.svelte';
  import AudioTrackView from './lib/AudioTrackView.svelte';
  import ProjectsMenu from './lib/ProjectsMenu.svelte';
  import Inspector from './lib/Inspector.svelte';
  import MixerDrawer from './lib/MixerDrawer.svelte';
  import MasterMeter from './lib/MasterMeter.svelte';
  import PluginPicker, { type InstalledPlugin } from './lib/PluginPicker.svelte';
  import { parseManifestJson, type PluginManifest } from './lib/plugin-manifest';
  import { sha256 as wasmSha256 } from './lib/plugin-loader';
  // Phase-8 M5: the picker installs via the worklet (canonical owner
  // of the plugin WebAssembly.Instance), NOT via the M3a JS-side
  // loadPlugin helper — that was a one-shot for the loader spec.
  // We re-use the manifest validator + the SRI hashing utility.
  import { createLayoutState } from './lib/layout-prefs.svelte';
  import {
    clearSeedHint,
    createProjectInfo,
    DEMO_PROJECT_ID,
    ensureDefaultProject,
    loadRegistry,
    setLastOpenedProject,
  } from './lib/project-registry';
  import * as Y from 'yjs';
  import {
    createProject,
    addSubtractiveTrack,
    addDrumkitTrack,
    addBusTrack,
    addAudioTrack,
    addWasmInsert,
    addWasmInsertByManifest,
    recordInstalledPlugin,
    listInstalledPlugins,
    setInsertParam,
    addAudioRegion,
    getAudioRegions,
    addInsert,
    addContainerSubInsert,
    setContainerBranchGain,
    setContainerSubInsertParam,
    addAutomationPoint,
    removeAutomationPoint,
    listAutomationLanes,
    getTrackInserts,
    getTrackSends,
    getTrackName,
    setAssetMetadata,
    setBpm,
    setMasterGain,
    setTrackGain,
    setTrackMute,
    setTrackSolo,
    getTrackPluginId,
    getTrackColor,
    getArmedTrackIdx,
    getPianoRollClipForTrack,
    addPianoRollNote,
    readPianoRollNotes,
    getBpm,
    getLoopRegion,
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
  import {
    attachBridge,
    attachWasmPluginToTrack,
    detachWasmPluginFromTrack,
    setHandleForManifestLookup,
    type Bridge,
  } from './lib/engine-bridge';
  import { createPluginUiHost, type PluginHost } from './lib/plugin-ui';
  import { parseManifest, type ParseResult } from './lib/plugin-manifest';
  import { createMidiInput, type MidiInputController } from './lib/midi-input';
  import * as assetStore from './lib/asset-store';
  import {
    attachRootSync,
    attachSatelliteSync,
    type AwarenessState,
    type RootHandle,
    type SatelliteIntent,
  } from './lib/satellite';
  import { createPipController, isPipSupported, type PipController } from './lib/pip';
  import { createAudioRecorder, type AudioRecorder } from './lib/audio-recorder';
  import { encodeWavMono16 } from './lib/wav';

  // Phase 7 M2 — per-machine layout prefs (pane widths + collapsed
  // states). Persisted to LocalStorage; not in the Y.Doc because
  // layout is screen-local, not project state.
  const layout = createLayoutState();

  // Phase 8 M5 — third-party plugin picker. Installed list is
  // session-only for now (Y.Doc persistence + boot re-registration
  // is the natural M5 follow-up but adds handle-remapping that's
  // orthogonal to the picker UX itself).
  let pickerOpen = $state(false);
  let installedPlugins = $state<InstalledPlugin[]>([]);

  /// Persist + register a plugin under a manifest URL. Writes the
  /// manifest to Y.Doc `meta.installedPlugins` so a reload can
  /// re-fetch and re-register — boot's `reloadInstalledPlugins`
  /// runs the same fetch+verify+register dance.
  async function installPluginFromUrl(url: string): Promise<string | undefined> {
    if (!project) return 'no project loaded';
    try {
      const manifestResp = await fetch(url);
      if (!manifestResp.ok) return `fetch failed: ${manifestResp.status}`;
      const text = await manifestResp.text();
      const parsed = parseManifestJson(text);
      if (!parsed.ok) {
        const head = parsed.issues[0];
        return `invalid manifest at ${head.path || '<root>'}: ${head.message}`;
      }
      const manifest = parsed.manifest;
      if (installedPlugins.some((p) => p.manifest.id === manifest.id)) {
        return `already installed: ${manifest.id}`;
      }
      const wasmAbs = new URL(manifest.wasm, new URL(url, window.location.href)).toString();
      const wasmResp = await fetch(wasmAbs);
      if (!wasmResp.ok) return `wasm fetch failed: ${wasmResp.status}`;
      const wasmBytes = new Uint8Array(await wasmResp.arrayBuffer());
      const got = `sha256-${await wasmSha256(wasmBytes)}`;
      if (got !== manifest.wasmIntegrity) {
        return `integrity mismatch: manifest says ${manifest.wasmIntegrity}, wasm hashed to ${got}`;
      }
      const handle = await audio.postLoadWasmPlugin(wasmBytes, {
        maxBlockSize: 256,
        inChannels: manifest.kind === 'instrument' ? 0 : 1,
        outChannels: 1,
      });
      installedPlugins = [...installedPlugins, { manifest, handle }];
      // Persist a manifest variant that points at the absolute wasm
      // URL we just verified — so reload doesn't have to re-resolve
      // the relative path against the original manifest URL (which
      // may not be retained).
      const persisted = { ...manifest, wasm: wasmAbs };
      recordInstalledPlugin(project, manifest.id, JSON.stringify(persisted));
      return undefined;
    } catch (err) {
      return `install error: ${(err as Error).message}`;
    }
  }

  function addInstalledPluginToSelectedTrack(plugin: InstalledPlugin): void {
    if (!project) return;
    if (selectedTrackIdx < 0 || selectedTrackIdx >= project.tracks.length) return;
    if (plugin.loadError || plugin.handle === 0) return; // unusable
    addWasmInsertByManifest(project, selectedTrackIdx, plugin.manifest.id);
    pickerOpen = false;
  }

  /// Phase-8 M5b — on every fresh boot, walk meta.installedPlugins
  /// and re-fetch + integrity-verify + re-register each manifest so
  /// the picker shows them and any track inserts that reference
  /// them by id can be addressed by the engine. Failures leave the
  /// entry with handle=0 + loadError set; the slot encoder drops
  /// failed inserts (silent audio passthrough), and the picker card
  /// shows a red badge so the user sees what happened.
  async function reloadInstalledPlugins(): Promise<void> {
    if (!project) return;
    const stored = listInstalledPlugins(project);
    if (stored.length === 0) {
      installedPlugins = [];
      return;
    }
    const next: InstalledPlugin[] = [];
    for (const { manifestJson } of stored) {
      let manifest: PluginManifest;
      try {
        const parsed = parseManifestJson(manifestJson);
        if (!parsed.ok) throw new Error(parsed.issues[0]?.message ?? 'invalid manifest');
        manifest = parsed.manifest;
      } catch (err) {
        // Persisted JSON has rotted somehow; surface but don't
        // crash — the entry stays so the user can see it.
        next.push({
          manifest: { id: 'unknown', name: 'Unknown', version: '0.0.0', kind: 'effect',
            wasm: '', wasmIntegrity: '', params: [] },
          handle: 0,
          loadError: `bad manifest JSON: ${(err as Error).message}`,
        });
        continue;
      }
      try {
        const wasmResp = await fetch(manifest.wasm);
        if (!wasmResp.ok) throw new Error(`fetch ${manifest.wasm}: ${wasmResp.status}`);
        const wasmBytes = new Uint8Array(await wasmResp.arrayBuffer());
        const got = `sha256-${await wasmSha256(wasmBytes)}`;
        if (got !== manifest.wasmIntegrity) {
          throw new Error(`integrity drift: expected ${manifest.wasmIntegrity}, got ${got}`);
        }
        const handle = await audio.postLoadWasmPlugin(wasmBytes, {
          maxBlockSize: 256,
          inChannels: manifest.kind === 'instrument' ? 0 : 1,
          outChannels: 1,
        });
        next.push({ manifest, handle });
      } catch (err) {
        next.push({ manifest, handle: 0, loadError: (err as Error).message });
      }
    }
    installedPlugins = next;
    bridge?.rebuild();
  }

  /// Register the manifestId → handle resolver with engine-bridge
  /// every time `installedPlugins` changes — the bridge's snapshot
  /// encoder uses this to convert persisted slot manifestIds back
  /// to live handles.
  $effect(() => {
    const map = new Map<string, number>();
    for (const p of installedPlugins) {
      if (p.handle > 0 && !p.loadError) map.set(p.manifest.id, p.handle);
    }
    setHandleForManifestLookup((id) => map.get(id));
  });

  // Phase 7 M2 follow-up — when the user pops the mixer into a
  // satellite window, hide the in-root drawer so the same control
  // doesn't appear twice. Poll `closed` so we can restore the drawer
  // automatically when the user closes the popup.
  let mixerPopup = $state<Window | null>(null);
  $effect(() => {
    if (!mixerPopup) return;
    const id = setInterval(() => {
      if (mixerPopup && mixerPopup.closed) {
        mixerPopup = null;
      }
    }, 500);
    return () => clearInterval(id);
  });

  // Hydrate the Y.Doc from IndexedDB before mounting the Sequencer.
  // Avoids the race where a fresh UI writes defaults that overwrite a
  // just-restored doc.
  let project = $state<Project | null>(null);
  let bridge = $state<Bridge | null>(null);
  let selectedTrackIdx = $state(0);
  let activeProjectId = $state<string | null>(null);
  // Tracks the selected track's plugin id so the panel re-mounts on
  // synth-track switch and disappears for non-synth tracks.
  let selectedPluginId = $derived.by(() => {
    if (!project) return null;
    return getTrackPluginId(project, selectedTrackIdx);
  });
  let selectedTrackKind = $derived.by((): string | null => {
    if (!project) return null;
    if (selectedTrackIdx < 0 || selectedTrackIdx >= project.tracks.length) return null;
    const id = project.tracks.get(selectedTrackIdx);
    const t = project.trackById.get(id);
    return (t?.get('kind') as string | undefined) ?? null;
  });
  // Track-color accent strip on the canvas header (Phase 7 M3) —
  // surfaces the selected track's identity color across all editor
  // views without each editor needing to know about it. Sourced from
  // a `trackMetaVersion` counter so Y.Doc mutations to name/color
  // trigger Svelte reactivity (the derived needs an observed signal
  // since Y.Doc reads aren't reactive on their own).
  let trackMetaVersion = $state(0);
  $effect(() => {
    const p = project;
    if (!p) return;
    const bump = () => { trackMetaVersion++; };
    p.trackById.observeDeep(bump);
    p.tracks.observe(bump);
    return () => {
      p.trackById.unobserveDeep(bump);
      p.tracks.unobserve(bump);
    };
  });
  let selectedTrackColor = $derived.by((): string => {
    void trackMetaVersion;
    if (!project) return 'transparent';
    return getTrackColor(project, selectedTrackIdx);
  });
  let selectedTrackNameValue = $derived.by((): string => {
    void trackMetaVersion;
    if (!project) return '';
    return getTrackName(project, selectedTrackIdx);
  });

  // Phase-5 M5: per-Audio-track recorder state. One recorder at a
  // time for now; multi-arm rides on the same Phase-9 polish queue
  // as the MIDI multi-arm item.
  let audioRecorderInstance: AudioRecorder | null = null;
  let audioRecordingTrackIdx = $state<number | null>(null);

  async function toggleAudioRecord(trackIdx: number): Promise<void> {
    if (!project) return;
    if (audioRecordingTrackIdx === trackIdx && audioRecorderInstance) {
      const pcm = await audioRecorderInstance.stop();
      const sampleRate = audioRecorderInstance.sampleRate;
      audioRecorderInstance.destroy();
      audioRecorderInstance = null;
      audioRecordingTrackIdx = null;
      if (pcm.length > 0) {
        await recordPcmIntoTrack(trackIdx, pcm, sampleRate);
      }
      return;
    }
    if (audioRecordingTrackIdx != null) return; // another track armed
    const ctx = await audio.audioContext();
    const recorder = await createAudioRecorder(ctx);
    await recorder.start();
    audioRecorderInstance = recorder;
    audioRecordingTrackIdx = trackIdx;
  }

  /// Phase-5 M5: drop captured Float32 PCM into the addressed Audio
  /// track. Encodes WAV, runs through the existing asset import path
  /// (M3) so the snapshot rebuild + register_asset flow does the
  /// rest. Used by both the live recorder and the test path that
  /// bypasses getUserMedia.
  async function recordPcmIntoTrack(
    trackIdx: number,
    pcm: Float32Array,
    sampleRate: number,
  ): Promise<{ hash: string }> {
    const bytes = encodeWavMono16(pcm, sampleRate);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return importAssetIntoTrack(trackIdx, bytes, `recording-${stamp}.wav`);
  }

  /// Phase-5 M3: import an audio asset into the addressed Audio track
  /// at tick 0 (full sample length). Hash to OPFS, decode, drop a
  /// region on the track. Engine-bridge picks up the new region via
  /// trackById.observeDeep, registers the asset, posts the snapshot.
  async function importAssetIntoTrack(
    trackIdx: number,
    bytes: Uint8Array,
    filename: string,
  ): Promise<{ hash: string }> {
    if (!project) throw new Error('project not ready');
    const hash = await assetStore.putBytes(bytes);
    const ctx = await audio.audioContext();
    const decoded = await assetStore.decode(hash, ctx);
    setAssetMetadata(project, hash, {
      channels: decoded.channels,
      sampleRate: decoded.sampleRate,
      frames: decoded.frames,
      sourceFilename: filename,
    });
    // Convert frames → ticks at the project's current BPM.
    const bpm = getBpm(project);
    const ticksPerSec = (bpm * PPQ) / 60;
    const seconds = decoded.frames / decoded.sampleRate;
    const lengthTicks = Math.max(1, Math.round(seconds * ticksPerSec));
    addAudioRegion(project, trackIdx, {
      assetHash: hash,
      startTick: 0,
      lengthTicks,
      startSample: 0,
      lengthSamples: decoded.frames,
      assetOffsetSamples: 0,
      gain: 1.0,
    });
    return { hash };
  }

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

  const initialRegistry = ensureDefaultProject();
  const initialProject =
    initialRegistry.projects.find((p) => p.id === initialRegistry.lastOpenedId) ??
    initialRegistry.projects[0];
  activeProjectId = initialProject.id;

  // Phase-7 follow-up — the demo song lives in a reserved, ephemeral
  // in-memory slot. `inDemo` drives the save-as banner; `demoDirty`
  // flips on the user's first edit so the banner appears exactly
  // when there's something worth preserving.
  let inDemo = $state(false);
  let demoDirty = $state(false);
  let demoSaveAsOpen = $state(false);
  let demoSaveAsName = $state('My Beat');

  /// Arm the dirty-watcher for the ephemeral demo: the next Y.Doc
  /// update after this call flips `demoDirty = true`, which surfaces
  /// the "Save as new project" banner. Callers wait until any
  /// programmatic enrichment (e.g. demo-song wasm plugin load) has
  /// finished writing to the doc — otherwise enrichment edits would
  /// be mistaken for user edits.
  function armDemoDirtyWatcher(): void {
    if (!project) return;
    const doc = project.doc;
    const onUpdate = () => {
      demoDirty = true;
      doc.off('update', onUpdate);
    };
    doc.on('update', onUpdate);
  }

  async function bootProject(docName: string, opts: { ephemeral?: boolean; seed?: 'demo' } = {}): Promise<void> {
    // Read the per-project seed hint and clear it so a refresh of the
    // same project doesn't re-seed (the Y.Doc already exists in IDB
    // by the time the hint matters; createProject only seeds when
    // the doc is empty, so this is belt-and-braces).
    const reg = loadRegistry();
    const info = reg.projects.find((x) => x.docName === docName);
    const seed = opts.seed ?? info?.seed;
    const p = await createProject({ docName, seed, ephemeral: opts.ephemeral });
    if (info?.id && info.seed) clearSeedHint(info.id);
    project = p;

    demoDirty = false;
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

    // Phase-6 M1+M2: attach root cross-window sync. Intents from
    // satellites land here and route to the same project helpers the
    // root UI uses.
    rootSyncHandle = attachRootSync(p.doc, (intent) => {
      handleSatelliteIntent(intent);
    });

    // Phase-6 M5: peer awareness — listen for satellites' published
    // state. Transport position published by root flows the other
    // way (publishPlayheadAwareness below).
    rootSyncHandle.onAwareness((wid, state) => {
      peerAwareness = { ...peerAwareness, [wid]: state };
    });

    exposeBridgeHandle(bridge);
  }

  const ready = (async () => {
    await bootProject(initialProject.docName);
    await reloadInstalledPlugins();
  })();

  async function tearDownCurrent(): Promise<void> {
    // Phase-8 M5b — unload session plugins from the worklet so a
    // freshly-loaded project starts from a clean plugin registry.
    for (const p of installedPlugins) {
      if (p.handle > 0) {
        try { await audio.postUnloadWasmPlugin(p.handle); } catch { /* idempotent */ }
      }
    }
    installedPlugins = [];
    pipController?.destroy();
    pipController = null;
    rootSyncHandle?.destroy();
    rootSyncHandle = null;
    midi?.destroy();
    midi = null;
    bridge?.destroy();
    bridge = null;
    project?.destroy();
    project = null;
  }

  async function switchProject(id: string): Promise<void> {
    // Demo slot: re-seeds on every click, even when we're already
    // on the demo. The user clicking ★ Demo Song again is an
    // explicit reset intent — discard any in-flight edits.
    if (id === DEMO_PROJECT_ID) {
      await tearDownCurrent();
      activeProjectId = DEMO_PROJECT_ID;
      inDemo = true;
      selectedTrackIdx = 0;
      // Use a stable docName so the read path (engine-bridge etc.)
      // has a name to log, but `ephemeral: true` keeps it off disk.
      await bootProject('__demo__', { ephemeral: true, seed: 'demo' });
      // Phase-8 M6 — load the bitcrusher WASM plugin and attach it
      // to the bass track. This grows the Demo Song to exercise the
      // third-party plugin runtime audibly (commitment #7).
      await enrichDemoSongWithBitcrusher();
      // Arm only AFTER enrichment so its writes aren't mistaken for
      // user edits by the "Save as new project" prompt.
      armDemoDirtyWatcher();
      return;
    }

    if (id === activeProjectId) return;
    const reg = loadRegistry();
    const next = reg.projects.find((p) => p.id === id);
    if (!next) return;
    await tearDownCurrent();
    setLastOpenedProject(id);
    activeProjectId = id;
    inDemo = false;
    selectedTrackIdx = 0;
    await bootProject(next.docName);
    await reloadInstalledPlugins();
  }

  /// Phase-8 M6 — load the Bitcrusher example plugin into the audio
  /// worklet and attach it to the demo song's bass track as an
  /// insert. Subtle settings (8-bit + 35% wet) so the demo gets a
  /// little grit without losing the bass tone. Idempotent against
  /// network failures: if the fetch or load throws, we log and move
  /// on — the demo is still playable, just without the crusher.
  async function enrichDemoSongWithBitcrusher(): Promise<void> {
    if (!project) return;
    // Install via the same picker path so the demo's Y.Doc carries
    // a stable installedPlugins entry — if the user forks the demo
    // via "Save as new project", the bitcrusher survives the fork
    // and re-loads on next boot.
    const err = await installPluginFromUrl('/example-plugins/wasm_bitcrusher.json');
    if (err) {
      console.warn('demo song bitcrusher enrichment failed:', err);
      return;
    }
    const bassIdx = 1; // demo seed layout: 0=Lead, 1=Bass, 2=Reverb, 3=Drums
    addWasmInsertByManifest(project, bassIdx, 'com.example.bitcrusher');
    const trackId = project.tracks.get(bassIdx);
    const track = project.trackById.get(trackId);
    const inserts = track?.get('inserts') as { length?: number } | undefined;
    const slotIdx = (inserts?.length ?? 0) - 1;
    if (slotIdx >= 0) {
      setInsertParam(project, bassIdx, slotIdx, 0, 8);    // 8-bit (subtle)
      setInsertParam(project, bassIdx, slotIdx, 1, 1);    // no SRR
      setInsertParam(project, bassIdx, slotIdx, 2, 0.35); // 35% wet
    }
  }

  /// Fork the current ephemeral demo Y.Doc into a new persistent
  /// project. Captures the doc state via Y.encodeStateAsUpdate, then
  /// creates a registered project + IndexedDB-backed Y.Doc and
  /// applies the update so the user's edits land intact. Switches
  /// to the new project; the demo's in-memory copy stays untouched,
  /// so the next ★ Demo Song click still seeds the canonical demo.
  async function saveDemoAs(name: string): Promise<void> {
    if (!project) return;
    if (!inDemo) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const state = Y.encodeStateAsUpdate(project.doc);
    const info = createProjectInfo(trimmed);
    // Tear down the demo; boot the new project; apply the captured
    // state. createProject seeds the doc with defaults if empty, so
    // we need to skip the seed by writing state BEFORE attaching
    // engine-bridge etc. The cleanest way: write to the new IDB
    // store directly, then boot normally.
    await tearDownCurrent();
    // Pre-seed the new IndexedDB store with the demo's state.
    const doc = new Y.Doc();
    const { IndexeddbPersistence } = await import('y-indexeddb');
    const provider = new IndexeddbPersistence(info.docName, doc);
    await provider.whenSynced;
    Y.applyUpdate(doc, state);
    // Force a flush so the data persists before we destroy.
    await new Promise<void>((resolve) => {
      // y-indexeddb flushes on local update; the applyUpdate above
      // already triggers a write. Give it one microtask to land.
      queueMicrotask(resolve);
    });
    provider.destroy();
    doc.destroy();

    setLastOpenedProject(info.id);
    activeProjectId = info.id;
    inDemo = false;
    demoDirty = false;
    demoSaveAsOpen = false;
    selectedTrackIdx = 0;
    await bootProject(info.docName);
    // The forked project carries the demo's meta.installedPlugins;
    // re-register so the bitcrusher (and any other installed
    // plugins) come back to life in the saved copy.
    await reloadInstalledPlugins();
  }

  // Phase-6 M5: tick-publishing loop. Runs while transport is on,
  // publishes the engine's current_tick at ~30 Hz over the
  // BroadcastChannel as awareness state — satellites (PIP, popups)
  // mirror playhead position without writing to the persistent
  // Y.Doc.
  let peerAwareness = $state<Record<string, AwarenessState>>({});
  let publishedPlayheadTick = $state(0);

  $effect(() => {
    if (!rootSyncHandle || !bridge) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const t = await audio.debugRead('currentTick');
      publishedPlayheadTick = t;
      rootSyncHandle?.publishAwareness({
        kind: 'root',
        playheadTick: t,
        focusedPanel: selectedTrackKind ?? undefined,
      });
    };
    // setInterval for reliability in headless Chromium (rAF throttles
    // in occluded tabs); ~30 Hz is a reasonable awareness publish
    // cadence for a transport-position cursor.
    const id = setInterval(tick, 33);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  });

  let rootSyncHandle = $state<RootHandle | null>(null);

  // Phase-6 M3: PIP transport. Lazy-create the controller; bindings
  // close over the live project + bridge so the polling loop in
  // TransportPipPanel sees current state.
  let pipController: PipController | null = null;
  let pipSupported = $state(isPipSupported());
  let pipPlaying = $state(false);

  function ensurePipController(): PipController | null {
    if (pipController) return pipController;
    if (!project || !bridge) return null;
    const p = project;
    const b = bridge;
    pipController = createPipController({
      getPlaying: () => pipPlaying,
      getBpm: () => getBpm(p),
      getProjectName: () => (p.meta.get('name') as string | undefined) ?? 'Untitled',
      play: () => {
        pipPlaying = true;
        b.setTransport(true);
      },
      stop: () => {
        pipPlaying = false;
        b.setTransport(false);
      },
    });
    return pipController;
  }

  async function openPip() {
    const c = ensurePipController();
    if (!c) return;
    try {
      await c.open();
    } catch (err) {
      console.warn('PIP open failed', err);
    }
  }

  function handleSatelliteIntent(intent: SatelliteIntent): void {
    if (!project || !bridge) return;
    switch (intent.kind) {
      case 'transport':
        bridge.setTransport(intent.play);
        break;
      case 'setBpm':
        setBpm(project, intent.bpm);
        break;
      case 'locate':
        bridge.locate(intent.tick);
        break;
      case 'setMasterGain':
        setMasterGain(project, intent.gain);
        break;
      case 'setTrackGain':
        setTrackGain(project, intent.track, intent.gain);
        break;
      case 'setTrackMute':
        setTrackMute(project, intent.track, intent.mute);
        break;
      case 'setTrackSolo':
        setTrackSolo(project, intent.track, intent.solo);
        break;
    }
  }

  // Phase 7 M2 — keyboard shortcuts. `Cmd/Ctrl+\` toggles the right
  // inspector; `Cmd/Ctrl+M` toggles the bottom mixer drawer. Both are
  // window-level so they work regardless of focus.
  $effect(() => {
    const onkey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '\\') {
        layout.inspectorCollapsed = !layout.inspectorCollapsed;
        e.preventDefault();
      } else if (e.key === 'm' || e.key === 'M') {
        layout.drawerExpanded = !layout.drawerExpanded;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onkey);
    return () => window.removeEventListener('keydown', onkey);
  });

  onDestroy(() => {
    pipController?.destroy();
    rootSyncHandle?.destroy();
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
          projectName: (p.meta.get('name') as string | undefined) ?? null,
          loopRegion: getLoopRegion(p),
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
          debugLoopEnd: () => audio.debugRead('loopEnd'),
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
          /// Test affordance — flat snapshot of per-track inserts/sends/
          /// names so the demo-song spec can assert the seeded shape
          /// without reaching into the Y.Doc.
          inspectTracks: () => {
            if (!project) return [];
            const out: Array<{
              idx: number;
              name: string;
              color: string;
              inserts: { kind: string }[];
              sends: { targetTrackIdx: number; level: number }[];
            }> = [];
            for (let i = 0; i < project.tracks.length; i++) {
              out.push({
                idx: i,
                name: getTrackName(project, i),
                color: getTrackColor(project, i),
                inserts: getTrackInserts(project, i).map((s) => ({ kind: s.kind })),
                sends: getTrackSends(project, i).map((s) => ({
                  targetTrackIdx: s.targetTrackIdx,
                  level: s.level,
                })),
              });
            }
            return out;
          },
          /// Phase-3 M4 — inspector backdoor for the demo-song spec to
          /// assert the seeded `CC#74 → lead filter cutoff` binding.
          getMidiBinding: (cc: number) => {
            if (!project) return null;
            return getMidiBinding(project, cc);
          },
          /// Phase-8 M1 — schema validator backdoor. Pure function;
          /// safe to expose. Used by tests/phase-8-manifest.spec.ts.
          parsePluginManifest: (raw: unknown): ParseResult => parseManifest(raw),
          /// Phase-8 M5b — test backdoor: write a manifest into
          /// `meta.installedPlugins` directly. Used by the failure
          /// spec to inject a manifest with a bogus wasm URL so
          /// reload-time re-registration fails predictably.
          _testRecordInstalledPlugin: (manifestId: string, manifestJson: string) => {
            if (!project) return;
            recordInstalledPlugin(project, manifestId, manifestJson);
          },
          /// Phase-8 M3b — load a third-party WASM plugin into the
          /// worklet and return the handle. Used by the e2e test;
          /// in production the picker UI (M5) will drive this with
          /// fetched + integrity-verified bytes from a manifest.
          loadWasmPlugin: async (
            bytes: Uint8Array,
            opts?: { maxBlockSize?: number; inChannels?: number; outChannels?: number },
          ): Promise<number> => audio.postLoadWasmPlugin(bytes, opts),
          unloadWasmPlugin: (handle: number) => audio.postUnloadWasmPlugin(handle),
          /// Bind a worklet-assigned wasm handle to a track. The
          /// engine-bridge picks it up on the next snapshot push and
          /// the engine builds a WasmPlugin for that track.
          attachWasmPluginToTrack: (
            trackIdx: number,
            handle: number,
            isInstrument: boolean,
          ) => {
            if (!project) return;
            if (trackIdx < 0 || trackIdx >= project.tracks.length) return;
            const trackId = project.tracks.get(trackIdx);
            attachWasmPluginToTrack(trackId, handle, isInstrument);
            bridge?.rebuild();
          },
          detachWasmPluginFromTrack: (trackIdx: number) => {
            if (!project) return;
            if (trackIdx < 0 || trackIdx >= project.tracks.length) return;
            const trackId = project.tracks.get(trackIdx);
            detachWasmPluginFromTrack(trackId);
            bridge?.rebuild();
          },
          /// Phase-8 M6 — attach a worklet-loaded WASM plugin to a
          /// track as an insert (effect-chain slot). Returns the
          /// new slot index. Tests use this to wire up a Bitcrusher
          /// on a synth track without going through M5's picker UI.
          addWasmInsert: (trackIdx: number, handle: number): number => {
            if (!project) return -1;
            addWasmInsert(project, trackIdx, handle);
            const trackId = project.tracks.get(trackIdx);
            const track = project.trackById.get(trackId);
            const inserts = track?.get('inserts') as { length: number } | undefined;
            return (inserts?.length ?? 0) - 1;
          },
          setInsertParam: (
            trackIdx: number,
            slotIdx: number,
            paramId: number,
            value: number,
          ) => {
            if (!project) return;
            setInsertParam(project, trackIdx, slotIdx, paramId, value);
          },
          // Phase-5 M2: OPFS asset store + register_asset path.
          assetStorePut: (bytes: Uint8Array) => assetStore.putBytes(bytes),
          assetStoreHas: (hash: string) => assetStore.has(hash),
          assetStoreList: () => assetStore.list(),
          registerAssetPcm: (assetId: number, pcm: Float32Array) =>
            audio.postRegisterAsset(assetId, pcm),
          debugAssetCount: () => audio.debugRead('assetCount'),
          // Phase-5 M3: import an asset into an Audio track.
          importAssetIntoTrack: (
            trackIdx: number,
            bytes: Uint8Array,
            filename: string,
          ) => importAssetIntoTrack(trackIdx, bytes, filename),
          getAudioRegions: (trackIdx: number) => {
            if (!project) return [];
            return getAudioRegions(project, trackIdx);
          },
          // Phase-5 M5: bypass-getUserMedia path for tests.
          recordPcmIntoTrack: (
            trackIdx: number,
            pcm: Float32Array,
            sampleRate: number,
          ) => recordPcmIntoTrack(trackIdx, pcm, sampleRate),
          // Phase-6 M1+M2: in-page satellite for tests. Creates a
          // satellite handle bound to the same BroadcastChannel root
          // is listening on; the test exercises the dispatch path.
          createSatelliteForTest: () => {
            if (!project) return null;
            const sat = attachSatelliteSync(project.doc);
            return {
              dispatch: (intent: SatelliteIntent) => sat.dispatch(intent),
              destroy: () => sat.destroy(),
            };
          },
          // Phase-6 M3: feature-detect + bindings smoke test for the
          // PIP transport. The real "open a PIP window" path needs a
          // user gesture in browsers that support Document PIP at
          // all; tests just verify the bindings produced are wired.
          isPipSupported: () => isPipSupported(),
          pipPlay: () => {
            const c = ensurePipController();
            void c;
            if (!bridge) return;
            pipPlaying = true;
            bridge.setTransport(true);
          },
          pipStop: () => {
            if (!bridge) return;
            pipPlaying = false;
            bridge.setTransport(false);
          },
          // Phase-6 M5 awareness inspectors.
          publishedPlayheadTick: () => publishedPlayheadTick,
          peerAwareness: () => peerAwareness,
          // Phase-4 M5 Container backdoor. UI for branch editing is
          // deferred to a Phase-9 polish pass.
          addContainerInsert: (trackIdx: number) => {
            if (!project) return;
            addInsert(project, trackIdx, 'builtin:container');
          },
          addContainerSubInsert: (
            trackIdx: number,
            slotIdx: number,
            branchIdx: number,
            kind:
              | 'builtin:gain'
              | 'builtin:eq'
              | 'builtin:compressor'
              | 'builtin:reverb'
              | 'builtin:delay',
          ) => {
            if (!project) return;
            addContainerSubInsert(project, trackIdx, slotIdx, branchIdx, kind);
          },
          setContainerBranchGain: (
            trackIdx: number,
            slotIdx: number,
            branchIdx: number,
            gain: number,
          ) => {
            if (!project) return;
            setContainerBranchGain(project, trackIdx, slotIdx, branchIdx, gain);
          },
          setContainerSubInsertParam: (
            trackIdx: number,
            slotIdx: number,
            branchIdx: number,
            subIdx: number,
            paramId: number,
            value: number,
          ) => {
            if (!project) return;
            setContainerSubInsertParam(
              project,
              trackIdx,
              slotIdx,
              branchIdx,
              subIdx,
              paramId,
              value,
            );
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
    <div
      class="app"
      data-testid="app-frame"
      style:--rail-w="{layout.railWidth}px"
      style:--insp-w="{layout.inspectorCollapsed ? 24 : layout.inspectorWidth}px"
    >

      <!-- TOP: 48px transport bar — brand, project menu, transport,
           toolbar, MIDI state, PIP, collaborator-avatar slot
           (placeholder for Phase 9 M4). -->
      <header class="transport" data-testid="top-bar">
        <div class="brand" aria-label="8347 Studio">
          <span class="ts">8</span><span class="nm">3</span>
          <span class="ts">4</span><span class="ts">7</span>
          <span class="lbl">STUDIO</span>
        </div>

        <ProjectsMenu
          activeProjectId={activeProjectId}
          onSwitch={(id) => void switchProject(id)}
        />

        {#key activeProjectId}
          <div class="transport-host"><Transport {project} /></div>
        {/key}

        <MasterMeter />

        <div class="spacer"></div>

        <button
          class="tb"
          data-testid="add-synth-track"
          onclick={() => {
            if (!project) return;
            addSubtractiveTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Synth</button>
        <button
          class="tb"
          data-testid="add-drumkit-track"
          onclick={() => {
            if (!project) return;
            addDrumkitTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Drums</button>
        <button
          class="tb"
          data-testid="add-bus-track"
          onclick={() => {
            if (!project) return;
            addBusTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Bus</button>
        <button
          class="tb"
          data-testid="add-audio-track"
          onclick={() => {
            if (!project) return;
            addAudioTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Audio</button>

        <button
          class="tb"
          data-testid="open-plugin-picker"
          onclick={() => (pickerOpen = true)}
          title="Browse + install third-party plugins"
        >+ Plugin</button>

        <button
          class="tb record"
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
          class="tb learn"
          class:active={learnActive}
          data-testid="midi-learn-toggle"
          onclick={toggleLearn}
          aria-pressed={learnActive}
          title="Bind hardware CCs to plugin parameters"
        >
          {#if learnActive && learnPendingCC != null}
            CC{learnPendingCC} → pick
          {:else if learnActive}
            Learn — wiggle
          {:else}
            Learn
          {/if}
        </button>

        <div class="midi-chip" data-testid="midi-chip">
          {#if midiStatus === 'unsupported'}
            <span class="midi-state">MIDI: unsupported</span>
          {:else if midiStatus === 'idle'}
            <button class="tb" data-testid="enable-midi" onclick={enableMidi}
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

        <!-- Collaborator-avatar slot (Phase 9 M4 populates this). -->
        <div class="avatars" data-testid="collab-avatars" aria-hidden="true"></div>

        <button
          class="tb"
          data-testid="open-pip"
          disabled={!pipSupported}
          onclick={openPip}
          title={pipSupported
            ? 'Open transport in a Picture-in-Picture window'
            : 'Document PIP not supported in this browser'}
        >⌐ PIP</button>
      </header>

      <!-- LEFT RAIL: track list. -->
      <aside class="rail" data-testid="rail">
        {#key activeProjectId}
          <TrackList
            {project}
            selectedIdx={selectedTrackIdx}
            onSelect={(i) => (selectedTrackIdx = i)}
          />
        {/key}
      </aside>

      <!-- MAIN CANVAS: the per-track editor (Sequencer / PianoRoll /
           AudioTrackView, plus insert + send rows). -->
      <main class="canvas" data-testid="canvas">
        <header class="canvas-head" data-testid="canvas-head">
          <span
            class="track-stripe"
            data-testid="canvas-track-stripe"
            style:background={selectedTrackColor}
          ></span>
          <span class="track-name" data-testid="canvas-track-name">{selectedTrackNameValue}</span>
          {#if selectedTrackKind}<span class="track-kind">{selectedTrackKind}</span>{/if}
        </header>

        {#if inDemo}
          <div class="demo-banner" data-testid="demo-banner" role="status">
            <span class="demo-tag">★ DEMO</span>
            {#if demoDirty}
              <span class="demo-msg">Edits to the Demo Song aren't saved.</span>
              {#if demoSaveAsOpen}
                <form
                  class="save-form"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void saveDemoAs(demoSaveAsName);
                  }}
                >
                  <input
                    class="save-name"
                    data-testid="demo-save-name"
                    bind:value={demoSaveAsName}
                    placeholder="My Beat"
                    autocomplete="off"
                  />
                  <button
                    type="submit"
                    class="save-go"
                    data-testid="demo-save-confirm"
                  >Save</button>
                  <button
                    type="button"
                    class="save-cancel"
                    data-testid="demo-save-cancel"
                    onclick={() => (demoSaveAsOpen = false)}
                  >Cancel</button>
                </form>
              {:else}
                <button
                  class="save-as"
                  data-testid="demo-save-as"
                  onclick={() => (demoSaveAsOpen = true)}
                >Save as new project…</button>
              {/if}
            {:else}
              <span class="demo-msg">Read-only demo. Edit anything to fork into a real project.</span>
            {/if}
          </div>
        {/if}
        {#key activeProjectId}
          {#if selectedTrackKind === 'Audio'}
            <div class="track-view">
              <AudioTrackView
                {project}
                trackIdx={selectedTrackIdx}
                recording={audioRecordingTrackIdx === selectedTrackIdx}
                onToggleRecord={() => toggleAudioRecord(selectedTrackIdx)}
              />
              <InsertSlots {project} trackIdx={selectedTrackIdx} />
              <SendList {project} trackIdx={selectedTrackIdx} />
            </div>
          {:else if selectedPluginId === 'builtin:subtractive' || selectedPluginId === 'builtin:drumkit'}
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
              <Sequencer {project} trackIdx={selectedTrackIdx} />
              <InsertSlots {project} trackIdx={selectedTrackIdx} />
              <SendList {project} trackIdx={selectedTrackIdx} />
            </div>
          {/if}
        {/key}
      </main>

      <!-- RIGHT INSPECTOR: collapsible. Shows the selected track's
           identity + summary (Phase 7 M4). -->
      <Inspector
        bind:collapsed={layout.inspectorCollapsed}
        width={layout.inspectorWidth}
        {project}
        selectedTrackIdx={selectedTrackIdx}
      />

      <!-- BOTTOM DRAWER: collapsible mixer. Hidden while the mixer
           lives in a satellite popup window (prevents duplicate
           controls). The drawer reappears when the popup closes. -->
      <MixerDrawer
        bind:expanded={layout.drawerExpanded}
        height={layout.drawerHeight}
        popped={mixerPopup != null && !mixerPopup.closed}
      >
        {#key activeProjectId}
          <Mixer
            {project}
            onPopout={() => {
              // If a popup is already open, just focus it instead of
              // opening a second copy.
              if (mixerPopup && !mixerPopup.closed) {
                mixerPopup.focus();
                return;
              }
              const w = window.open(
                '?panel=mixer',
                'mixer-popup',
                'width=420,height=420',
              );
              mixerPopup = w;
            }}
          />
        {/key}
      </MixerDrawer>

      <!-- Phase 8 M5 — plugin picker modal. Lives outside the
           grid so its <dialog> backdrop covers everything. -->
      <PluginPicker
        bind:open={pickerOpen}
        installed={installedPlugins}
        selectedTrackName={selectedTrackNameValue || 'track'}
        onInstall={installPluginFromUrl}
        onAddToTrack={addInstalledPluginToSelectedTrack}
      />
    </div>
  {/if}
{/await}

<style>
  /* P1 grid: top transport (48px) → middle row (rail / canvas /
     inspector) → bottom drawer (auto). The middle row stretches to
     fill the viewport minus the transport and the drawer. */
  .app {
    display: grid;
    grid-template-rows: 48px 1fr auto;
    grid-template-columns: var(--rail-w) 1fr var(--insp-w);
    height: 100vh;
    min-height: 0;
    background: var(--bg-1);
    color: var(--fg-0);
    font-size: var(--text-12);
  }
  .app > :global(.transport) {
    grid-column: 1 / -1;
    grid-row: 1;
  }
  .app > .rail     { grid-column: 1; grid-row: 2; }
  .app > .canvas   { grid-column: 2; grid-row: 2; }
  .app > :global(.inspector) { grid-column: 3; grid-row: 2; }
  .app > :global(.drawer)    { grid-column: 1 / -1; grid-row: 3; }

  /* TOP TRANSPORT BAR */
  .transport {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 0 var(--sp-4);
    background: linear-gradient(180deg, #15171b, #0d0e11);
    border-bottom: 1px solid var(--line-2);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.6);
    /* No overflow clipping — popovers like the ProjectsMenu dropdown
       must be free to escape the 48px height. White-space:nowrap +
       flex-shrink on individual items keeps everything on one row;
       on truly narrow viewports content can spill rightward (better
       than clipping a dropdown). */
    white-space: nowrap;
    /* Sit above the grid below so absolute-positioned popovers from
       toolbar items render on top of the canvas / inspector. */
    position: relative;
    z-index: 5;
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 1px;
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding-right: var(--sp-3);
    border-right: 1px solid var(--line-1);
    margin-right: var(--sp-2);
  }
  .brand .ts { color: var(--accent); }
  .brand .nm { color: var(--fg-0); }
  .brand .lbl {
    color: var(--fg-3);
    font-size: 9px;
    margin-left: 6px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }

  .transport-host {
    display: flex;
    align-items: center;
    /* Phase 7 M3 reskins Transport itself; M2 just hosts it. */
  }

  .spacer { flex: 1; min-width: 8px; }

  .tb {
    font-family: var(--font-sans);
    font-size: var(--text-11);
    background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
    color: var(--fg-1);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    padding: 4px 10px;
    height: 26px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-shadow: var(--shadow-rim);
  }
  .tb:hover {
    background: linear-gradient(180deg, #2a2e36, var(--bg-3));
    color: var(--fg-0);
  }
  .tb:disabled { opacity: 0.45; cursor: not-allowed; }
  .tb:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .record .record-dot {
    width: 8px;
    height: 8px;
    background: var(--fg-3);
    border-radius: 50%;
  }
  .record.recording {
    border-color: var(--rec);
    color: var(--rec-pulse);
    background: rgba(226, 52, 45, 0.12);
  }
  .record.recording .record-dot {
    background: var(--rec-pulse);
    animation: rec-pulse 1s infinite;
  }
  @keyframes rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .learn.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-tint);
  }

  .midi-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-2);
    font-family: var(--font-mono);
    font-size: var(--text-11);
  }
  .midi-chip select {
    background: var(--bg-0);
    color: var(--fg-0);
    border: 1px solid var(--line-1);
    padding: 2px 4px;
    font: inherit;
    border-radius: var(--r-sm);
  }
  .midi-state { color: var(--fg-2); }

  .avatars {
    /* placeholder for Phase 9 M4 collaborator avatars; reserves a
       layout slot so M3 + tests can target it. */
    min-width: 28px;
    height: 24px;
    border-left: 1px solid var(--line-1);
    margin-left: var(--sp-2);
  }

  /* LEFT RAIL */
  .rail {
    background: var(--bg-2);
    border-right: 1px solid var(--line-1);
    overflow: auto;
    min-width: 0;
  }

  /* MAIN CANVAS */
  .canvas {
    overflow: auto;
    background: var(--bg-1);
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .canvas-head {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-2);
    flex-shrink: 0;
  }
  .canvas-head .track-stripe {
    width: 4px;
    height: 18px;
    border-radius: var(--r-sm);
    flex-shrink: 0;
  }
  .canvas-head .track-name {
    font-family: var(--font-sans);
    font-size: var(--text-12);
    color: var(--fg-0);
    font-weight: 500;
  }
  .canvas-head .track-kind {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .canvas > :global(*:not(.canvas-head):not(.demo-banner)) {
    padding: var(--sp-4);
  }

  .demo-banner {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4);
    background: var(--accent-tint);
    border-bottom: 1px solid var(--accent-lo);
    color: var(--fg-1);
    font-size: var(--text-11);
    flex-shrink: 0;
  }
  .demo-tag {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--accent);
    letter-spacing: 0.1em;
    font-weight: 600;
  }
  .demo-msg { color: var(--fg-1); }
  .save-as,
  .save-go,
  .save-cancel {
    font-family: var(--font-sans);
    font-size: var(--text-11);
    height: 22px;
    padding: 0 var(--sp-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--line-2);
    background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
    color: var(--fg-0);
    cursor: pointer;
  }
  .save-as:hover, .save-go:hover, .save-cancel:hover {
    background: linear-gradient(180deg, #2a2e36, var(--bg-3));
  }
  .save-go {
    background: linear-gradient(180deg, var(--accent-hi), var(--accent), var(--accent-lo));
    border-color: var(--accent-lo);
    color: var(--accent-fg);
  }
  .save-form {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    margin-left: auto;
  }
  .save-name {
    height: 22px;
    padding: 0 var(--sp-2);
    border-radius: var(--r-sm);
    border: 1px solid var(--line-2);
    background: var(--bg-0);
    color: var(--fg-0);
    font-family: var(--font-sans);
    font-size: var(--text-11);
  }
  .save-as { margin-left: auto; }
  .synth-stack,
  .track-view {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .loading {
    font-family: var(--font-sans);
    color: var(--fg-2);
    padding: var(--sp-5);
  }
</style>
