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
  import ArrangementView from './lib/arrange/ArrangementView.svelte';
  import AutomationLanes from './lib/AutomationLanes.svelte';
  import SettingsPanel from './lib/SettingsPanel.svelte';
  import ShareExportModal from './lib/ShareExportModal.svelte';
  type ShareTab = 'share' | 'export' | 'render';
  import ProjectsMenu from './lib/ProjectsMenu.svelte';
  import Inspector from './lib/Inspector.svelte';
  import MixerDrawer from './lib/MixerDrawer.svelte';
  import MasterMeter from './lib/MasterMeter.svelte';
  import PluginPicker, { type InstalledPlugin } from './lib/PluginPicker.svelte';
  import * as pluginInstall from './lib/plugin-install';
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
    getStepSeqClipForTrack,
    createClipAtTick,
    addPianoRollNote,
    readPianoRollNotes,
    readStepVelocities,
    getBpm,
    getLoopRegion,
    getMidiBinding,
    setMidiBinding,
    removeMidiBinding,
    setSynthParam,
    seedDefaults,
    claimProjectOwner,
    canEditProject,
    PPQ,
    STEP_TICKS,
    type Project,
    type AutoTargetKind,
  } from './lib/project';
  import * as audio from './lib/audio';
  import {
    attachBridge,
    setHandleForManifestLookup,
    type Bridge,
  } from './lib/engine-bridge';
  import { createMidiInput, type MidiInputController } from './lib/midi-input';
  import { buildMidiHandler } from './lib/midi-routing';
  import * as assetStore from './lib/asset-store';
  import { parseBundle } from './lib/bundle';
  import {
    saveCheckpoint,
    listCheckpoints,
    getCheckpointData,
    type CheckpointMeta,
  } from './lib/checkpoints';
  import { enrichDemoSong } from './lib/demo-enrichment';
  import { attachWindowDebug } from './lib/debug-bridge';
  import {
    attachRootSync,
    type AwarenessState,
    type RootHandle,
    type SatelliteIntent,
  } from './lib/satellite';
  import {
    createDocsPipController,
    createPipController,
    isPipSupported,
    type PipController,
  } from './lib/pip';
  import { createAudioRecorder, type AudioRecorder } from './lib/audio-recorder';
  import { encodeWavMono16 } from './lib/wav';
  import { createCollabSession } from './lib/collab-session.svelte';

  // Phase-9 M5 — collab mode is opt-in via `?room=<id>`. main.ts
  // passes the id through; null/undefined means "local mode".
  const { roomId: initialRoomId = null } = $props<{ roomId?: string | null }>();

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

  /// Install pipeline + Y.Doc-driven reload live in
  /// `lib/plugin-install.ts`. App.svelte just owns the reactive
  /// `installedPlugins` $state + the picker UI, and forwards into
  /// the module with the worklet `loadWasm` dep injected.
  async function installPluginFromUrl(url: string): Promise<string | undefined> {
    if (!project) return 'no project loaded';
    const result = await pluginInstall.installPluginFromUrl(
      project,
      url,
      installedPlugins,
      { loadWasm: audio.postLoadWasmPlugin },
    );
    if ('err' in result) return result.err;
    installedPlugins = [...installedPlugins, result.ok];
    return undefined;
  }

  function addInstalledPluginToSelectedTrack(plugin: InstalledPlugin): void {
    if (!project) return;
    if (selectedTrackIdx < 0 || selectedTrackIdx >= project.tracks.length) return;
    if (plugin.loadError || plugin.handle === 0) return; // unusable
    addWasmInsertByManifest(project, selectedTrackIdx, plugin.manifest.id);
    pickerOpen = false;
  }

  async function reloadInstalledPlugins(): Promise<void> {
    if (!project) return;
    installedPlugins = await pluginInstall.reloadInstalledPlugins(project, {
      loadWasm: audio.postLoadWasmPlugin,
    });
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
  // Phase-12 M3 — main canvas view mode. 'track' = the per-track editor
  // (Sequencer / PianoRoll / AudioTrackView); 'arrange' = the all-tracks
  // ArrangementView timeline.
  let viewMode = $state<'track' | 'arrange'>('track');
  // Phase-12 M5a — which pattern the per-track editor opens, per track.
  // Set by arrangement drill-in / empty-lane create; undefined falls
  // back to the track's first clip (legacy single-pattern behaviour).
  let activePatternByTrack = $state<Record<number, string | undefined>>({});
  let activeProjectId = $state<string | null>(null);
  // Active project's IDB docName — the key for version checkpoints (M5).
  let currentDocName = $state('');
  // Bumped when a collab joiner's room content first arrives. Folded
  // into the project-view key so the views — which mounted against an
  // empty doc and won't observe late-synced tracks/clips — re-mount
  // once the shared project lands.
  let collabViewEpoch = $state(0);
  const projectViewKey = $derived(`${activeProjectId}#${collabViewEpoch}`);
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
  /// Phase-10 M5 — reactive mirror of `meta.armedTrackId` so the
  /// AudioTrackView can paint the armed-not-recording glow. Read
  /// directly from Y.Doc; meta.observe drives the refresh.
  let armedTrackVersion = $state(0);
  $effect(() => {
    const p = project;
    if (!p) return;
    const bump = () => { armedTrackVersion++; };
    p.meta.observe(bump);
    return () => p.meta.unobserve(bump);
  });
  let isAudioTrackArmed = $derived.by((): boolean => {
    void armedTrackVersion;
    if (!project || selectedTrackKind !== 'Audio') return false;
    return getArmedTrackIdx(project) === selectedTrackIdx;
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
  // Phase-9 M4 — broadcast our currently-selected track over
  // awareness so peers can render a ghost ring on the same row.
  $effect(() => {
    session.collab?.setSelectedTrack(selectedTrackIdx);
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
  /// Phase-10 M5 — start time of the in-flight take in ms (Date.now)
  /// + the human-readable input label, both surfaced to
  /// AudioTrackView so it can render the growing striped placeholder
  /// + the "● REC from <device>" header during recording.
  let audioRecordingStartedAtMs = $state<number | null>(null);
  let audioRecordingInputLabel = $state<string | null>(null);

  async function toggleAudioRecord(trackIdx: number): Promise<void> {
    if (!project) return;
    if (audioRecordingTrackIdx === trackIdx && audioRecorderInstance) {
      const pcm = await audioRecorderInstance.stop();
      const sampleRate = audioRecorderInstance.sampleRate;
      audioRecorderInstance.destroy();
      audioRecorderInstance = null;
      audioRecordingTrackIdx = null;
      audioRecordingStartedAtMs = null;
      audioRecordingInputLabel = null;
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
    audioRecordingStartedAtMs = Date.now();
    audioRecordingInputLabel = recorder.inputLabel || 'Default input';
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

  /// Phase-5 M3: import an audio asset into the addressed Audio track.
  /// Hash to OPFS, decode, drop a region on the track at `startTick`
  /// (defaults to 0 for the recording + demo-song callers). Engine-
  /// bridge picks up the new region via trackById.observeDeep,
  /// registers the asset, posts the snapshot. Returns the hash plus
  /// the region's tick length so callers laying out multiple imports
  /// (drag-drop / picker) can advance the cursor without overlap.
  async function importAssetIntoTrack(
    trackIdx: number,
    bytes: Uint8Array,
    filename: string,
    startTick = 0,
  ): Promise<{ hash: string; lengthTicks: number }> {
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
      startTick: Math.max(0, Math.round(startTick)),
      lengthTicks,
      startSample: 0,
      lengthSamples: decoded.frames,
      assetOffsetSamples: 0,
      gain: 1.0,
    });
    return { hash, lengthTicks };
  }

  /// Phase-10 P6 — user-facing audio import (drag-drop onto a track, or
  /// the track's Import… button). Filters to audio files, then imports
  /// each sequentially starting at `atTick`, advancing by the prior
  /// region's tick length so a multi-file drop lays out left-to-right
  /// without overlap. Decode failures (unsupported / corrupt) surface
  /// on `audioImportError` instead of failing silently.
  const AUDIO_EXTS = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;
  let audioImportError = $state<string | null>(null);
  let audioImportErrorTimer: ReturnType<typeof setTimeout> | null = null;
  function flashAudioImportError(msg: string) {
    audioImportError = msg;
    if (audioImportErrorTimer) clearTimeout(audioImportErrorTimer);
    audioImportErrorTimer = setTimeout(() => { audioImportError = null; }, 5000);
  }
  async function handleImportAudioFiles(
    trackIdx: number,
    files: File[],
    atTick: number,
  ): Promise<void> {
    if (!canEdit) return;
    const audioFiles = files.filter(
      (f) => f.type.startsWith('audio/') || AUDIO_EXTS.test(f.name),
    );
    const rejected = files.length - audioFiles.length;
    if (audioFiles.length === 0) {
      flashAudioImportError(
        rejected > 0 ? 'Not an audio file — drop a WAV / MP3 / FLAC / OGG.' : 'No file to import.',
      );
      return;
    }
    audioImportError = null;
    let cursor = Math.max(0, Math.round(atTick));
    for (const file of audioFiles) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { lengthTicks } = await importAssetIntoTrack(trackIdx, bytes, file.name, cursor);
        cursor += lengthTicks;
      } catch (err) {
        console.warn('audio import failed:', file.name, err);
        flashAudioImportError(`Couldn't import "${file.name}" — unsupported or corrupt audio.`);
      }
    }
    if (rejected > 0 && audioFiles.length > 0) {
      flashAudioImportError(`Skipped ${rejected} non-audio file${rejected > 1 ? 's' : ''}.`);
    }
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

  // Phase-9 — collab session lifecycle. Owns `activeRoomId`,
  // `syncStatus`, the awareness peer view, and the persisted user
  // identity. App.svelte forwards into this handle from button
  // clicks and project-boot wiring; everything reactive in the
  // template reads `session.activeRoomId`, `session.user.name`,
  // `session.collab?.peers`, etc.
  // svelte-ignore state_referenced_locally
  const session = createCollabSession(initialRoomId);

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

  async function bootProject(docName: string, opts: { ephemeral?: boolean; seed?: 'demo' | 'blank' } = {}): Promise<void> {
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
    currentDocName = docName;

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
    midi = createMidiInput(buildMidiHandler({
      project: p,
      bridge: bridge!,
      routeIdx,
      isLearnActive: () => learnActive,
      capturePendingCC: (cc) => { learnPendingCC = cc; },
      recordNoteOn: (pitch, velocity) => {
        if (!recording) return;
        recBuffer.push({ pitch, velocity, onMs: performance.now(), offMs: null });
      },
      recordNoteOff: (pitch) => {
        if (!recording) return;
        for (let i = recBuffer.length - 1; i >= 0; i--) {
          if (recBuffer[i].pitch === pitch && recBuffer[i].offMs == null) {
            recBuffer[i].offMs = performance.now();
            break;
          }
        }
      },
    }));
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
    if (initialRoomId) {
      // `?room=<id>` boot path: ephemeral Y.Doc + sync attached.
      // The server populates the doc via the y-protocols sync
      // handshake; the local replica persists only for the tab's
      // lifetime (no IDB mirror — keeps the data model uncomplicated).
      // Boot BLANK — the room's shared project arrives via the sync
      // handshake. Seeding a default here would merge a duplicate
      // project into the shared doc (joiner ends up with its own
      // default track plus the host's tracks). Once the initial state
      // lands, if the room turned out to be empty we're its first
      // occupant — seed a default project then so there's something to
      // work with; a joiner that received content skips this.
      await bootProject(`__room_${initialRoomId}__`, { ephemeral: true, seed: 'blank' });
      if (project) {
        const joined = project;
        session.attach(joined, initialRoomId, selectedTrackIdx, () => {
          if (joined.tracks.length === 0) seedDefaults(joined);
          // Re-mount the project views: they mounted against the empty
          // pre-sync doc and won't otherwise pick up the now-present
          // tracks/clips (their observers bail when there's no clip).
          collabViewEpoch += 1;
        });
      }
    } else {
      await bootProject(initialProject.docName);
      await reloadInstalledPlugins();
    }
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
    docsPip?.destroy();
    docsPip = null;
    rootSyncHandle?.destroy();
    rootSyncHandle = null;
    session.destroy();
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
      if (project) {
        await enrichDemoSong(project, { installPluginFromUrl, importAssetIntoTrack });
      }
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

  // Demo Song post-seed enrichment moved to `lib/demo-enrichment.ts`;
  // App.svelte just hands it the local `installPluginFromUrl` +
  // `importAssetIntoTrack` so the module stays free of bridge /
  // worklet wiring.

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

  /// Phase-10 M7c — import a `.8347.zip` bundle as a brand-new
  /// project. Restores asset bytes into OPFS, then pre-seeds a fresh
  /// IDB store with the bundle's Y.Doc state (same flush dance as
  /// saveDemoAs so createProject's blank seed doesn't clobber it) and
  /// switches to it.
  async function importBundleAsProject(file: File): Promise<void> {
    let parsed: ReturnType<typeof parseBundle>;
    try {
      parsed = parseBundle(new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      window.alert(`Could not read bundle: ${(err as Error).message}`);
      return;
    }
    const { manifest, projectBytes, assets } = parsed;
    // Restore asset bytes into OPFS first — putBytes re-hashes, so the
    // stored hash matches the project's references; idempotent if an
    // asset already exists locally.
    for (const bytes of assets.values()) {
      await assetStore.putBytes(bytes);
    }
    const fallback = file.name.replace(/\.8347\.zip$/i, '').replace(/\.zip$/i, '');
    const name = (manifest?.name || fallback || 'Imported').trim();
    await hydrateProjectFromUpdate(name, projectBytes);
  }

  /// Create a brand-new registered project from a raw Y.Doc update and
  /// switch to it. Shared by bundle import (M7c) and version restore
  /// (M5). Pre-seeds the IDB store before booting (the saveDemoAs flush
  /// dance) so createProject's blank seed doesn't clobber the state.
  async function hydrateProjectFromUpdate(name: string, projectBytes: Uint8Array): Promise<void> {
    const info = createProjectInfo(name);
    await tearDownCurrent();
    const doc = new Y.Doc();
    const { IndexeddbPersistence } = await import('y-indexeddb');
    const provider = new IndexeddbPersistence(info.docName, doc);
    await provider.whenSynced;
    Y.applyUpdate(doc, projectBytes);
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });
    provider.destroy();
    doc.destroy();
    setLastOpenedProject(info.id);
    activeProjectId = info.id;
    inDemo = false;
    selectedTrackIdx = 0;
    await bootProject(info.docName);
    await reloadInstalledPlugins();
  }

  // Phase-11 M5 — version history (checkpoints). Snapshots key off the
  // active docName. Restore forks to a new project (reliable recovery
  // without an in-place CRDT rewind).
  async function saveVersion(label: string): Promise<void> {
    if (!project || !currentDocName) return;
    await saveCheckpoint(currentDocName, Y.encodeStateAsUpdate(project.doc), label.trim());
  }
  function loadVersions(): Promise<CheckpointMeta[]> {
    return currentDocName ? listCheckpoints(currentDocName) : Promise.resolve([]);
  }
  async function restoreVersion(id: number): Promise<void> {
    const bytes = await getCheckpointData(id);
    if (!bytes) return;
    await hydrateProjectFromUpdate(`Restored · ${new Date().toLocaleString()}`, bytes);
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

  // Phase-8 follow-up — Document PIP user guide. PIP-supported
  // browsers get a floating reader; everyone else opens the docs in
  // a new browser tab via the `?docs=1` route.
  let docsPip: PipController | null = null;
  async function openDocs() {
    if (isPipSupported()) {
      if (!docsPip) docsPip = createDocsPipController();
      try { await docsPip.open(); return; } catch { /* fall through */ }
    }
    window.open('?docs=1', 'docs', 'noopener');
  }
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

  // Phase-10 M6 — Settings modal.
  let settingsOpen = $state(false);
  function openSettings() { settingsOpen = true; }
  function closeSettings() { settingsOpen = false; }
  function selectMidiDeviceById(id: string | null) {
    if (!midi) return;
    midi.selectedDeviceId = id;
  }

  // Phase-10 M7 — Share & Export modal.
  let shareOpen = $state(false);
  let shareInitialTab = $state<ShareTab>('share');
  function openShare(tab: ShareTab = 'share') {
    shareInitialTab = tab;
    shareOpen = true;
  }
  function closeShare() { shareOpen = false; }
  function startCollabSession() {
    // Copy the (per-machine registry) project name into the synced
    // Y.Doc meta so joiners show the same name — the registry entry
    // never crosses the wire, but meta does.
    if (project && activeProjectId) {
      const info = loadRegistry().projects.find((p) => p.id === activeProjectId);
      if (info) {
        const p = project;
        p.doc.transact(() => p.meta.set('name', info.name));
      }
    }
    // Phase-11 — the sharer owns the session; joiners are read-only
    // until granted. Claiming resets editor grants for a fresh session.
    if (project) claimProjectOwner(project, session.user.id);
    void session.share(project, selectedTrackIdx);
  }
  function endCollabSession() { session.detach(); }

  // Phase-11 M2 — client-side edit lock. `canEdit` is true outside a
  // room (local mode) and, inside a room, only for the owner + granted
  // editors. Recomputed when the room changes or meta.collab updates.
  // Soft tier: gates the UI; server enforcement is deferred.
  let canEdit = $state(true);
  $effect(() => {
    const p = project;
    const inRoom = session.activeRoomId != null;
    if (!p || !inRoom) { canEdit = true; return; }
    const compute = () => { canEdit = canEditProject(p, session.user.id); };
    compute();
    p.meta.observe(compute);
    return () => p.meta.unobserve(compute);
  });

  // Phase-11 M5 — periodic auto-checkpoint. Any Y.Doc edit marks the
  // project dirty; a timer saves an 'auto' version when dirty, so the
  // version history accrues over time without manual saves.
  const AUTO_CHECKPOINT_MS = 180_000;
  let versionDirty = false;
  $effect(() => {
    const p = project;
    const docName = currentDocName;
    if (!p || !docName) return;
    versionDirty = false;
    const onUpdate = () => { versionDirty = true; };
    p.doc.on('update', onUpdate);
    const timer = setInterval(() => {
      if (!versionDirty) return;
      versionDirty = false;
      void saveCheckpoint(docName, Y.encodeStateAsUpdate(p.doc), 'auto');
    }, AUTO_CHECKPOINT_MS);
    return () => { p.doc.off('update', onUpdate); clearInterval(timer); };
  });

  // Synced project name for the menu trigger when in a room. The
  // joiner has no registry entry for the shared project, so it reads
  // the name from the synced Y.Doc meta (set by the host on share).
  let sharedName = $state<string | null>(null);
  $effect(() => {
    const p = project;
    if (!p || !session.activeRoomId) { sharedName = null; return; }
    const read = () => { sharedName = (p.meta.get('name') as string | undefined) ?? null; };
    read();
    p.meta.observe(read);
    return () => p.meta.unobserve(read);
  });

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

  // Test-only debug surface (window.__project + window.__bridge) is
  // installed via attachWindowDebug below — see `lib/debug-bridge.ts`
  // for the full list of test entry points. exposeDebugHandle is a
  // stub kept so bootProject reads naturally; the real wiring is the
  // single attachWindowDebug call at the bottom of this script.
  function exposeDebugHandle(_p: Project) { /* see attachWindowDebug */ }

  function exposeBridgeHandle(_b: Bridge) { /* see attachWindowDebug */ }

  // Wire the test-only window.__project + window.__bridge once at
  // mount. Getters re-evaluate every access so the surface always
  // reflects the current project / bridge / recording state — no
  // need to re-attach on switchProject.
  attachWindowDebug({
    project: () => project,
    bridge: () => bridge,
    midi: () => midi,
    recording: () => recording,
    pipSetPlaying: (on) => { pipPlaying = on; },
    ensurePipController,
    publishedPlayheadTick: () => publishedPlayheadTick,
    peerAwareness: () => peerAwareness,
    importAssetIntoTrack,
    recordPcmIntoTrack,
    setMockRecording: (trackIdx, label, startedAtMs) => {
      audioRecordingTrackIdx = trackIdx;
      audioRecordingInputLabel = label;
      audioRecordingStartedAtMs = startedAtMs;
    },
  });
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
          roomId={session.activeRoomId}
          sharedName={sharedName}
          onSwitch={(id) => void switchProject(id)}
          onImport={(file) => importBundleAsProject(file)}
        />

        {#key projectViewKey}
          <div class="transport-host"><Transport {project} collab={session.collab} canEdit={canEdit} /></div>
        {/key}

        <MasterMeter />

        <div class="spacer"></div>

        <button
          class="tb"
          data-testid="add-synth-track"
          disabled={!canEdit}
          onclick={() => {
            if (!project) return;
            addSubtractiveTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Synth</button>
        <button
          class="tb"
          data-testid="add-drumkit-track"
          disabled={!canEdit}
          onclick={() => {
            if (!project) return;
            addDrumkitTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Drums</button>
        <button
          class="tb"
          data-testid="add-bus-track"
          disabled={!canEdit}
          onclick={() => {
            if (!project) return;
            addBusTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Bus</button>
        <button
          class="tb"
          data-testid="add-audio-track"
          disabled={!canEdit}
          onclick={() => {
            if (!project) return;
            addAudioTrack(project);
            selectedTrackIdx = project.tracks.length - 1;
          }}
        >+ Audio</button>

        <button
          class="tb"
          data-testid="open-plugin-picker"
          disabled={!canEdit}
          onclick={() => (pickerOpen = true)}
          title="Browse + install third-party plugins"
        >+ Plugin</button>

        <button
          class="tb record"
          class:recording
          data-testid="record"
          disabled={!canEdit}
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
          disabled={!canEdit}
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

        <!-- Phase-9 M4 — collaborator avatars. Self first, then every
             remote peer with their awareness color + initial. -->
        <div class="avatars" data-testid="collab-avatars">
          {#if session.activeRoomId}
            <span
              class="avatar self"
              data-testid="collab-self-avatar"
              style:background-color={session.user.color}
              title="You — {session.user.name}"
            >{session.user.name.slice(0, 1).toUpperCase()}</span>
            {#each session.collab?.peers ?? [] as p (p.id)}
              {@const name = p.state.user?.name ?? `peer ${p.id}`}
              {@const color = p.state.user?.color ?? 'var(--fg-2)'}
              <span
                class="avatar peer"
                data-testid={`collab-peer-avatar-${p.id}`}
                style:background-color={color}
                title={name}
              >{name.slice(0, 1).toUpperCase()}</span>
            {/each}
          {/if}
        </div>

        <button
          class="tb share"
          class:connected={session.activeRoomId != null}
          data-testid="share-button"
          onclick={() => openShare('share')}
          title={session.activeRoomId
            ? `Manage collab session (status: ${session.syncStatus})`
            : 'Open Share & Export'}
          aria-label="Share collab session"
        >{session.activeRoomId ? `⤴ ${session.syncStatus}` : '⤴ Share'}</button>

        <button
          class="tb"
          data-testid="open-pip"
          disabled={!pipSupported}
          onclick={openPip}
          title={pipSupported
            ? 'Float the transport in an always-on-top Picture-in-Picture window'
            : 'Picture-in-Picture not supported in this browser'}
          aria-label="Open floating transport (Picture-in-Picture)"
        >⌐ Transport</button>

        <button
          class="tb"
          data-testid="open-docs"
          onclick={() => void openDocs()}
          title="Open the user guide{pipSupported ? ' in a Picture-in-Picture window' : ' in a new tab'}"
          aria-label="Open user guide"
        >?</button>

        <button
          class="tb"
          data-testid="open-settings"
          onclick={openSettings}
          title="Open settings (MIDI devices, bindings, …)"
          aria-label="Open settings"
        >⚙</button>
      </header>

      <!-- LEFT RAIL: track list. -->
      <aside class="rail" data-testid="rail">
        {#key projectViewKey}
          <TrackList
            {project}
            selectedIdx={selectedTrackIdx}
            onSelect={(i) => (selectedTrackIdx = i)}
            collab={session.collab}
            canEdit={canEdit}
          />
        {/key}
      </aside>

      <!-- MAIN CANVAS: the per-track editor (Sequencer / PianoRoll /
           AudioTrackView, plus insert + send rows). -->
      <main class="canvas" class:readonly={!canEdit} data-testid="canvas">
        {#if session.activeRoomId && !canEdit}
          <div class="viewonly-banner" data-testid="viewonly-banner" role="status">
            <span class="vo-tag">VIEW ONLY</span>
            <span class="vo-msg">The owner hasn't granted you editing — you can play and follow along.</span>
          </div>
        {/if}
        <header class="canvas-head" data-testid="canvas-head">
          <!-- Phase-12 M3 — track ↔ arrange view toggle. -->
          <div class="view-toggle" data-testid="view-toggle" role="group" aria-label="Canvas view">
            <button
              class="vt"
              class:active={viewMode === 'track'}
              data-testid="view-toggle-track"
              aria-pressed={viewMode === 'track'}
              onclick={() => (viewMode = 'track')}
            >Track</button>
            <button
              class="vt"
              class:active={viewMode === 'arrange'}
              data-testid="view-toggle-arrange"
              aria-pressed={viewMode === 'arrange'}
              onclick={() => (viewMode = 'arrange')}
            >Arrange</button>
          </div>
          <span
            class="track-stripe"
            data-testid="canvas-track-stripe"
            style:background={selectedTrackColor}
          ></span>
          <span class="track-name" data-testid="canvas-track-name">{selectedTrackNameValue}</span>
          {#if selectedTrackKind}<span class="track-kind">{selectedTrackKind}</span>{/if}
          <!-- Phase-9 M6 — contention indicator. When a remote peer
               has the same track selected as we do, show their name
               + color so the user knows their edits may overlap. -->
          {#if session.collab}
            {@const peersHere = session.collab.peers.filter((p) => p.state.selectedTrackIdx === selectedTrackIdx && p.state.user)}
            {#if peersHere.length > 0}
              <span class="peer-contention" data-testid="canvas-peer-contention">
                {#each peersHere as p (p.id)}
                  <span
                    class="peer-pill"
                    style:--peer-color={p.state.user?.color ?? 'var(--accent-hi)'}
                  >{p.state.user?.name ?? `peer ${p.id}`} is editing</span>
                {/each}
              </span>
            {/if}
          {/if}
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
        {#key projectViewKey}
          {#if viewMode === 'arrange'}
            <ArrangementView
              {project}
              canEdit={canEdit}
              selectedTrackIdx={selectedTrackIdx}
              onSelectTrack={(i) => (selectedTrackIdx = i)}
              onDrillIn={(i, patternId) => {
                selectedTrackIdx = i;
                activePatternByTrack[i] = patternId;
                viewMode = 'track';
              }}
              onCreateAt={(i, tick) => {
                if (!project) return;
                const r = createClipAtTick(project, i, tick);
                if (r) {
                  selectedTrackIdx = i;
                  activePatternByTrack[i] = r.patternId;
                }
              }}
              playheadTick={publishedPlayheadTick}
            />
          {:else if selectedTrackKind === 'Audio'}
            <div class="track-view">
              <AudioTrackView
                {project}
                trackIdx={selectedTrackIdx}
                canEdit={canEdit}
                armed={isAudioTrackArmed}
                recording={audioRecordingTrackIdx === selectedTrackIdx}
                recordingStartedAtMs={audioRecordingTrackIdx === selectedTrackIdx ? audioRecordingStartedAtMs : null}
                inputLabel={audioRecordingTrackIdx === selectedTrackIdx ? audioRecordingInputLabel : null}
                importError={audioImportError}
                onToggleRecord={() => toggleAudioRecord(selectedTrackIdx)}
                onImportFiles={(files, atTick) => handleImportAudioFiles(selectedTrackIdx, files, atTick)}
              />
              <AutomationLanes {project} trackIdx={selectedTrackIdx} />
              <InsertSlots {project} trackIdx={selectedTrackIdx} />
              <SendList {project} trackIdx={selectedTrackIdx} />
            </div>
          {:else if selectedPluginId === 'builtin:subtractive' || selectedPluginId === 'builtin:drumkit'}
            <div class="synth-stack">
              <PianoRoll {project} trackIdx={selectedTrackIdx} collab={session.collab} clipId={activePatternByTrack[selectedTrackIdx]} />
              <AutomationLanes {project} trackIdx={selectedTrackIdx} />
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
              <Sequencer {project} trackIdx={selectedTrackIdx} clipId={activePatternByTrack[selectedTrackIdx]} />
              <AutomationLanes {project} trackIdx={selectedTrackIdx} />
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
        {#key projectViewKey}
          <Mixer
            {project}
            canEdit={canEdit}
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

      <!-- Phase 10 M6 — Settings modal (currently MIDI tab only). -->
      <SettingsPanel
        {project}
        open={settingsOpen}
        midiStatus={midiStatus}
        midiDevices={midiDevices}
        selectedMidiId={selectedMidiId}
        learnActive={learnActive}
        learnPendingCC={learnPendingCC}
        onEnableMidi={() => void enableMidi()}
        onSelectMidiDevice={selectMidiDeviceById}
        onToggleLearn={toggleLearn}
        onClose={closeSettings}
      />

      <!-- Phase 10 M7 — Share & Export modal. -->
      <ShareExportModal
        {project}
        {session}
        open={shareOpen}
        initialTab={shareInitialTab}
        selectedTrackIdx={selectedTrackIdx}
        onStartSession={startCollabSession}
        onEndSession={endCollabSession}
        onSaveVersion={saveVersion}
        loadVersions={loadVersions}
        onRestoreVersion={(id) => { closeShare(); void restoreVersion(id); }}
        onClose={closeShare}
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
    /* Phase-9 M5 — currently just the local user's avatar.
       M4 will expand into a peer list rendered from awareness. */
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 28px;
    height: 24px;
    border-left: 1px solid var(--line-1);
    margin-left: var(--sp-2);
    padding-left: var(--sp-2);
  }
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-family: var(--font-mono);
    font-size: var(--text-10);
    font-weight: 600;
    color: #000;
    border: 1px solid rgba(0, 0, 0, 0.25);
  }
  .tb.share.connected {
    color: var(--accent);
    border-color: var(--accent);
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
  .canvas-head .peer-contention {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    padding-right: var(--sp-2);
  }
  .peer-pill {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 8px;
    border-radius: 9px;
    border: 1px solid var(--peer-color);
    color: var(--peer-color);
    background: rgba(255, 255, 255, 0.04);
    font-family: var(--font-mono);
    font-size: var(--text-10);
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
  /* The arrangement timeline manages its own scroll + fills the canvas;
     opt it out of the default child padding. */
  .canvas > :global(.arrangement) {
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
  }
  .view-toggle {
    display: inline-flex;
    border: 1px solid var(--line-0);
    border-radius: var(--r-sm);
    overflow: hidden;
    flex-shrink: 0;
  }
  .view-toggle .vt {
    appearance: none;
    border: none;
    background: var(--bg-1);
    color: var(--fg-2);
    font-family: var(--font-mono);
    font-size: var(--text-10);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 10px;
    cursor: pointer;
  }
  .view-toggle .vt.active {
    background: var(--accent-hi, #6cf);
    color: var(--bg-0, #000);
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

  /* Phase-11 M2 — collab read-only mode. The canvas (all per-track
     editors) goes non-interactive for a viewer; the banner explains
     why. Track selection (rail) + transport play stay live. */
  .canvas.readonly { pointer-events: none; }
  .canvas.readonly .viewonly-banner { pointer-events: auto; }
  .viewonly-banner {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4);
    background: var(--bg-2);
    border-bottom: 1px solid var(--line-2);
    color: var(--fg-1);
    font-size: var(--text-11);
    flex-shrink: 0;
    pointer-events: auto;
  }
  .vo-tag {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--solo);
    letter-spacing: 0.1em;
    font-weight: 600;
  }
  .vo-msg { color: var(--fg-2); }
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
