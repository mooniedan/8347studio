// Test-only window-attached debug surface.
//
// `window.__bridge` and `window.__project` are the canonical entry
// points the Playwright suite uses to poke at engine state, write
// to the Y.Doc through real helpers, and short-circuit user
// gestures (recording without a mic, MIDI without a controller).
// They're not part of the user-facing API and production builds
// could strip them behind `import.meta.env.DEV` if bundle size
// becomes a concern.
//
// App.svelte composes one `DebugBridgeDeps` bag at boot and passes
// it through `attachWindowDebug`. The dict literal lives here so
// App.svelte stays focused on layout + composition; tests still
// access the surface via `(window as any).__bridge.foo(...)`.

import * as assetStore from './asset-store';
import * as audio from './audio';
import { isPipSupported } from './pip';
import { attachSatelliteSync, type AwarenessState, type SatelliteIntent } from './satellite';
import { parseManifest, type ParseResult } from './plugin-manifest';
import { createPluginUiHost, type PluginHost } from './plugin-ui';
import {
  attachWasmPluginToTrack as bridgeAttachWasm,
  detachWasmPluginFromTrack as bridgeDetachWasm,
  type Bridge,
} from './engine-bridge';
import {
  addAutomationPoint,
  addContainerSubInsert,
  addInsert,
  addSubtractiveTrack,
  addWasmInsert,
  addAudioRegion,
  getAudioRegions,
  setAudioRegionFade,
  setAudioRegionGain,
  updateAudioRegion,
  type AudioRegionInput,
  type AudioRegionPatch,
  getLoopRegion,
  getMidiBinding,
  setMidiBinding,
  removeMidiBinding,
  listMidiBindings,
  type MidiBinding,
  getPianoRollClipForTrack,
  getStepSeqClipForTrack,
  getTrackColor,
  getTrackInserts,
  getTrackName,
  getTrackSends,
  listAutomationLanes,
  readPianoRollNotes,
  readStepVelocities,
  recordInstalledPlugin,
  removeAutomationPoint,
  setContainerBranchGain,
  setContainerSubInsertParam,
  setInsertParam,
  setSynthParam as setSynthParamHelper,
  type AutoTargetKind,
  type Project,
} from './project';
import type { MidiInputController } from './midi-input';

export interface DebugBridgeDeps {
  /// Getters so the debug surface always reads the *current* values
  /// even though it's installed once at boot.
  project: () => Project | null;
  bridge: () => Bridge | null;
  midi: () => MidiInputController | null;
  recording: () => boolean;
  pipSetPlaying: (on: boolean) => void;
  ensurePipController: () => unknown;
  publishedPlayheadTick: () => number;
  peerAwareness: () => Record<string, AwarenessState>;
  /// App.svelte-local helpers that need the surrounding closure.
  importAssetIntoTrack: (
    trackIdx: number,
    bytes: Uint8Array,
    filename: string,
  ) => Promise<{ hash: string }>;
  recordPcmIntoTrack: (
    trackIdx: number,
    pcm: Float32Array,
    sampleRate: number,
  ) => Promise<unknown>;
  /// Phase-10 M5 test hook. Lets specs flip the audio-recording
  /// visual state without calling `getUserMedia` (which Playwright
  /// can't grant). Production code never invokes this.
  setMockRecording: (
    trackIdx: number | null,
    inputLabel: string | null,
    startedAtMs: number | null,
  ) => void;
}

function withProject<T>(
  deps: DebugBridgeDeps,
  fn: (p: Project) => T,
  fallback: T,
): T {
  const p = deps.project();
  return p ? fn(p) : fallback;
}

/// Window-attached snapshot of project shape — small + cheap, read
/// fresh each access via the getter. Returns an empty-shape object
/// when there's no live project (briefly true during switchProject)
/// so tests that read `__project.trackCount` see 0 instead of a
/// `Cannot read properties of null` throw.
function buildProjectDebug(p: Project | null) {
  if (!p) {
    return {
      trackCount: 0,
      clipCount: 0,
      firstClipKind: null,
      firstTrackGain: null,
      projectName: null,
      loopRegion: null,
    };
  }
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
}

function buildDebugBridge(deps: DebugBridgeDeps): Record<string, unknown> {
  // Bridge-dependent closures use `b?.foo(...)` so the surface is
  // populated even during early boot — tests that probe pure
  // functions (parseManifest, assetStorePut) don't have to wait for
  // the audio worklet. Each `window.__bridge` access re-evaluates
  // the getter so closures always see the current Bridge after a
  // project switch.
  const b = deps.bridge();
  return {
    rebuild: () => b?.rebuild(),
    setTransport: (play: boolean) => b?.setTransport(play),
    debugTrackGain:    (track: number) => audio.debugRead('trackGain', track),
    debugTrackCount:   () => audio.debugRead('trackCount'),
    debugMasterGain:   () => audio.debugRead('masterGain'),
    debugCurrentTick:  () => audio.debugRead('currentTick'),
    debugBpm:          () => audio.debugRead('bpm'),
    debugLoopEnd:      () => audio.debugRead('loopEnd'),
    debugTrackPeak:    (track: number) => audio.debugRead('trackPeak', track),
    debugTrackParam:   (track: number, paramId: number) =>
      audio.debugTrackParam(track, paramId),
    /// Phase-8 M8 — UI drives synth params via Knob/Slider, not
    /// range-input element values. Tests write through this Y.Doc
    /// path so the round-trip (Y.Doc → SAB → engine) stays exercised.
    setSynthParam: (track: number, paramId: number, value: number) =>
      withProject(deps, (p) => setSynthParamHelper(p, track, paramId, value), undefined),
    setParam: (track: number, paramId: number, value: number) =>
      b?.setParam(track, paramId, value),
    addSubtractiveTrack: () => withProject(deps, (p) => {
      addSubtractiveTrack(p);
      return p.tracks.length - 1;
    }, -1),
    createPluginUiHost: (trackIdx: number): PluginHost | null =>
      withProject(deps, (p) => createPluginUiHost(p, trackIdx), null),
    noteOn: (track: number, pitch: number, velocity: number) =>
      b?.noteOn(track, pitch, velocity),
    noteOff: (track: number, pitch: number) => b?.noteOff(track, pitch),
    midiCc: (track: number, cc: number, value: number) =>
      b?.midiCc(track, cc, value),
    /// Test backdoor: simulate a raw MIDI message on the input
    /// path. Bypasses requestMIDIAccess so Playwright can drive
    /// the decode logic.
    midiSimulate: (data: number[]) => deps.midi()?.simulate(data),
    isRecording: () => deps.recording(),
    /// Test affordance — dump the current note set on a track's
    /// PianoRoll clip. Lets recording-style specs assert without
    /// reaching into Y.Doc directly.
    getPianoRollNotes: (trackIdx: number) => withProject(deps, (p) => {
      const clip = getPianoRollClipForTrack(p, trackIdx);
      return clip ? readPianoRollNotes(clip) : [];
    }, []),
    /// Phase-10 M1 — per-step velocity readout for the demo
    /// assertion. Returns null for tracks without a step-seq clip.
    stepVelocities: (trackIdx: number) => withProject(deps, (p) => {
      const clip = getStepSeqClipForTrack(p, trackIdx);
      return clip ? readStepVelocities(clip) : null;
    }, null),
    /// Phase-4 M4 automation backdoor — UI for the lane editor is
    /// in the Phase-10 polish queue; tests use the data path.
    addAutomationPoint: (
      trackIdx: number,
      target: AutoTargetKind,
      slotIdx: number,
      paramId: number,
      tick: number,
      value: number,
    ) => withProject(deps, (p) => {
      addAutomationPoint(p, trackIdx, target, slotIdx, paramId, { tick, value });
    }, undefined),
    removeAutomationPoint: (
      trackIdx: number,
      target: AutoTargetKind,
      slotIdx: number,
      paramId: number,
      pointIdx: number,
    ) => withProject(deps, (p) => {
      removeAutomationPoint(p, trackIdx, target, slotIdx, paramId, pointIdx);
    }, undefined),
    listAutomationLanes: () => withProject(deps, (p) => listAutomationLanes(p), []),
    /// Test affordance — flat snapshot of per-track inserts/sends/
    /// names so the demo-song spec can assert the seeded shape
    /// without reaching into the Y.Doc.
    inspectTracks: () => withProject(deps, (p) => {
      const out: Array<{
        idx: number;
        name: string;
        color: string;
        inserts: { kind: string }[];
        sends: { targetTrackIdx: number; level: number }[];
      }> = [];
      for (let i = 0; i < p.tracks.length; i++) {
        out.push({
          idx: i,
          name: getTrackName(p, i),
          color: getTrackColor(p, i),
          inserts: getTrackInserts(p, i).map((s) => ({ kind: s.kind })),
          sends: getTrackSends(p, i).map((s) => ({
            targetTrackIdx: s.targetTrackIdx,
            level: s.level,
          })),
        });
      }
      return out;
    }, []),
    /// Phase-3 M4 — assert seeded `CC#74 → lead filter cutoff`
    /// binding without poking at the Y.Doc directly.
    getMidiBinding: (cc: number) =>
      withProject(deps, (p) => getMidiBinding(p, cc), null),
    setMidiBinding: (cc: number, binding: MidiBinding) =>
      withProject(deps, (p) => { setMidiBinding(p, cc, binding); return true; }, false),
    removeMidiBinding: (cc: number) =>
      withProject(deps, (p) => { removeMidiBinding(p, cc); return true; }, false),
    listMidiBindings: () =>
      withProject(deps, (p) => listMidiBindings(p), [] as ReturnType<typeof listMidiBindings>),
    /// Phase-8 M1 — pure manifest validator. Safe to expose.
    parsePluginManifest: (raw: unknown): ParseResult => parseManifest(raw),
    /// Phase-8 M5b — inject a manifest into `meta.installedPlugins`
    /// directly. Used by the failure spec to set up a bogus wasm URL
    /// so reload-time re-registration fails predictably.
    _testRecordInstalledPlugin: (manifestId: string, manifestJson: string) =>
      withProject(deps, (p) => recordInstalledPlugin(p, manifestId, manifestJson), undefined),
    /// Phase-8 M3b — load a third-party WASM plugin into the
    /// worklet and return the handle. Tests use this directly; the
    /// picker UI (M5) drives the same path in production.
    loadWasmPlugin: (
      bytes: Uint8Array,
      opts?: { maxBlockSize?: number; inChannels?: number; outChannels?: number },
    ): Promise<number> => audio.postLoadWasmPlugin(bytes, opts),
    unloadWasmPlugin: (handle: number) => audio.postUnloadWasmPlugin(handle),
    attachWasmPluginToTrack: (
      trackIdx: number,
      handle: number,
      isInstrument: boolean,
    ) => withProject(deps, (p) => {
      if (trackIdx < 0 || trackIdx >= p.tracks.length) return;
      const trackId = p.tracks.get(trackIdx);
      bridgeAttachWasm(trackId, handle, isInstrument);
      b?.rebuild();
    }, undefined),
    detachWasmPluginFromTrack: (trackIdx: number) =>
      withProject(deps, (p) => {
        if (trackIdx < 0 || trackIdx >= p.tracks.length) return;
        const trackId = p.tracks.get(trackIdx);
        bridgeDetachWasm(trackId);
        b?.rebuild();
      }, undefined),
    /// Phase-8 M6 — attach a worklet-loaded WASM plugin to a track
    /// as an insert. Returns the new slot index.
    addWasmInsert: (trackIdx: number, handle: number): number =>
      withProject(deps, (p) => {
        addWasmInsert(p, trackIdx, handle);
        const trackId = p.tracks.get(trackIdx);
        const track = p.trackById.get(trackId);
        const inserts = track?.get('inserts') as { length: number } | undefined;
        return (inserts?.length ?? 0) - 1;
      }, -1),
    setInsertParam: (
      trackIdx: number,
      slotIdx: number,
      paramId: number,
      value: number,
    ) => withProject(deps, (p) => setInsertParam(p, trackIdx, slotIdx, paramId, value), undefined),
    // Phase-5 M2 — OPFS asset store + register_asset path.
    assetStorePut: (bytes: Uint8Array) => assetStore.putBytes(bytes),
    assetStoreHas: (hash: string) => assetStore.has(hash),
    assetStoreList: () => assetStore.list(),
    registerAssetPcm: (assetId: number, pcm: Float32Array) =>
      audio.postRegisterAsset(assetId, pcm),
    debugAssetCount: () => audio.debugRead('assetCount'),
    // Phase-5 M3: import an asset into an Audio track.
    importAssetIntoTrack: deps.importAssetIntoTrack,
    getAudioRegions: (trackIdx: number) =>
      withProject(deps, (p) => getAudioRegions(p, trackIdx), []),
    addAudioRegion: (trackIdx: number, region: AudioRegionInput) =>
      withProject(deps, (p) => { addAudioRegion(p, trackIdx, region); return true; }, false),
    setAudioRegionFade: (
      trackIdx: number,
      regionIdx: number,
      which: 'in' | 'out',
      samples: number,
    ) =>
      withProject(
        deps,
        (p) => setAudioRegionFade(p, trackIdx, regionIdx, which, samples),
        false,
      ),
    setAudioRegionGain: (trackIdx: number, regionIdx: number, gain: number) =>
      withProject(
        deps,
        (p) => setAudioRegionGain(p, trackIdx, regionIdx, gain),
        false,
      ),
    updateAudioRegion: (
      trackIdx: number,
      regionIdx: number,
      patch: AudioRegionPatch,
    ) =>
      withProject(
        deps,
        (p) => updateAudioRegion(p, trackIdx, regionIdx, patch),
        false,
      ),
    // Phase-5 M5: bypass-getUserMedia path for tests.
    recordPcmIntoTrack: deps.recordPcmIntoTrack,
    setMockRecording: deps.setMockRecording,
    // Phase-6 M1+M2: in-page satellite for tests.
    createSatelliteForTest: () => withProject(deps, (p) => {
      const sat = attachSatelliteSync(p.doc);
      return {
        dispatch: (intent: SatelliteIntent) => sat.dispatch(intent),
        destroy: () => sat.destroy(),
      };
    }, null),
    // Phase-6 M3 — feature-detect + bindings smoke. Real "open a
    // PIP window" needs a user gesture; tests just verify the
    // bindings are wired.
    isPipSupported: () => isPipSupported(),
    pipPlay: () => {
      deps.ensurePipController();
      const br = deps.bridge();
      if (!br) return;
      deps.pipSetPlaying(true);
      br.setTransport(true);
    },
    pipStop: () => {
      const br = deps.bridge();
      if (!br) return;
      deps.pipSetPlaying(false);
      br.setTransport(false);
    },
    // Phase-6 M5 awareness inspectors.
    publishedPlayheadTick: () => deps.publishedPlayheadTick(),
    peerAwareness: () => deps.peerAwareness(),
    // Phase-4 M5 Container backdoor — branch editor is Phase-10
    // polish.
    addContainerInsert: (trackIdx: number) =>
      withProject(deps, (p) => { addInsert(p, trackIdx, 'builtin:container'); }, undefined),
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
    ) => withProject(deps, (p) => {
      addContainerSubInsert(p, trackIdx, slotIdx, branchIdx, kind);
    }, undefined),
    setContainerBranchGain: (
      trackIdx: number,
      slotIdx: number,
      branchIdx: number,
      gain: number,
    ) => withProject(deps, (p) => {
      setContainerBranchGain(p, trackIdx, slotIdx, branchIdx, gain);
    }, undefined),
    setContainerSubInsertParam: (
      trackIdx: number,
      slotIdx: number,
      branchIdx: number,
      subIdx: number,
      paramId: number,
      value: number,
    ) => withProject(deps, (p) => {
      setContainerSubInsertParam(p, trackIdx, slotIdx, branchIdx, subIdx, paramId, value);
    }, undefined),
  };
}

/// Install both `window.__project` and `window.__bridge` getters.
/// Called once at boot; closures over `deps` provide the current
/// state on every access.
///
/// `__bridge` returns `undefined` until the audio bridge is wired
/// up so `bridgeReady` helpers can poll for `__bridge != null` as a
/// signal that the engine is live — matches the legacy behaviour.
export function attachWindowDebug(deps: DebugBridgeDeps): void {
  Object.defineProperty(window, '__project', {
    configurable: true,
    get: () => buildProjectDebug(deps.project()),
  });
  Object.defineProperty(window, '__bridge', {
    configurable: true,
    get: () => deps.bridge() ? buildDebugBridge(deps) : undefined,
  });
}
