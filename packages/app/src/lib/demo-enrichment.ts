// Demo Song post-seed enrichment.
//
// `seedDemoSong` in project.ts runs synchronously inside a Y.Doc
// transaction; anything that needs async work (fetching a plugin
// manifest, decoding audio with `decodeAudioData`, etc.) lives here
// instead. App.svelte awaits `enrichDemoSong` after the seed so the
// asynchronous additions land before the dirty-watcher arms.
//
// Three enrichments today:
//   1. Bitcrusher WASM plugin loaded as an insert on the Bass track,
//      with a mix-sweep automation lane (Phase-8 M6 coverage).
//   2. A synth-generated 2 s pad-riser dropped onto a fresh Audio
//      track (Phase-5 audio path coverage; Phase-10 M1 closeout).
//   3. The real `bell.wav` (44.1 kHz) imported onto a "Bell" Audio
//      track (Phase-10 P6 — exercises decoding a real on-disk file).
//
// All are exercised by the demo-song spec — see
// `packages/app/tests/demo-song.spec.ts`.

import {
  addAudioTrack,
  setAudioRegionFade,
  addAutomationPoint,
  addWasmInsertByManifest,
  setInsertParam,
  setTrackColor,
  setTrackGain,
  getAssetMetadata,
  getAudioRegions,
  type Project,
} from './project';
import { TRACK_PALETTE } from './track-color';

export interface DemoEnrichmentDeps {
  /// Install a plugin via the picker path (so the demo's Y.Doc
  /// carries a stable `meta.installedPlugins` entry). Returns a
  /// non-empty error string on failure or `undefined` on success.
  installPluginFromUrl: (url: string) => Promise<string | undefined>;
  /// Decode + register an audio asset on the given track index.
  /// Routes through OPFS + the engine's register_asset path.
  importAssetIntoTrack: (
    trackIdx: number,
    bytes: Uint8Array,
    filename: string,
  ) => Promise<{ hash: string }>;
}

/// Run every post-seed enrichment. Failures of individual steps log
/// but don't throw — the demo stays playable even if e.g. the
/// bitcrusher fetch is blocked.
export async function enrichDemoSong(
  project: Project,
  deps: DemoEnrichmentDeps,
): Promise<void> {
  await enrichWithBitcrusher(project, deps);
  await enrichWithAudioRiser(project, deps);
  await enrichWithBellSample(project, deps);
}

/// Phase-8 M6 — bitcrusher on the demo's bass track with a wet
/// mix sweep automating across the 4-bar loop. Settles into a
/// subtle 8-bit baseline so the bass tone reads as "crusher
/// enabled" without losing the fundamental.
async function enrichWithBitcrusher(
  project: Project,
  deps: DemoEnrichmentDeps,
): Promise<void> {
  const bcErr = await deps.installPluginFromUrl('/example-plugins/wasm_bitcrusher.json');
  if (bcErr) {
    console.warn('demo song bitcrusher install failed:', bcErr);
    return;
  }
  // Pre-install the gain plugin so the picker's Installed tab has
  // more than one entry on first open — proves the picker pipeline
  // is real, not a one-off for the bitcrusher.
  const gainErr = await deps.installPluginFromUrl('/example-plugins/wasm_gain_plugin.json');
  if (gainErr) {
    console.warn('demo song gain install failed:', gainErr);
    // non-fatal — keep going.
  }

  const bassIdx = 1; // demo seed layout: 0=Lead, 1=Bass, 2=Reverb, 3=Drums
  addWasmInsertByManifest(project, bassIdx, 'com.example.bitcrusher');
  const trackId = project.tracks.get(bassIdx);
  const track = project.trackById.get(trackId);
  const inserts = track?.get('inserts') as { length?: number } | undefined;
  const slotIdx = (inserts?.length ?? 0) - 1;
  if (slotIdx < 0) return;

  setInsertParam(project, bassIdx, slotIdx, 0, 8); // 8-bit baseline
  setInsertParam(project, bassIdx, slotIdx, 1, 1); // no SRR

  // Mix sweep — wet ramps up across the 4-bar loop, then drops
  // back. Same shape as the lead's filter sweep, on a different
  // surface so the demo exercises both automation targets.
  const STEP_TICKS_LOCAL = 240;
  const STEPS = 64; // PROG_STEPS from the seed
  const total = STEPS * STEP_TICKS_LOCAL;
  addAutomationPoint(project, bassIdx, 'insert', slotIdx, 2, { tick: 0,            value: 0.10 });
  addAutomationPoint(project, bassIdx, 'insert', slotIdx, 2, { tick: total / 2,    value: 0.7  });
  addAutomationPoint(project, bassIdx, 'insert', slotIdx, 2, { tick: total - 1,    value: 0.25 });
}

/// Phase-10 M1 closeout — drop a synth-generated 2 s pad-riser on
/// a fresh Audio track so the Phase-5 audio path (OPFS asset
/// store → engine register_asset → region playback) is exercised
/// by the cumulative regression.
async function enrichWithAudioRiser(
  project: Project,
  deps: DemoEnrichmentDeps,
): Promise<void> {
  // addAudioTrack returns the id; the index is the new track's
  // position at the end of the project.tracks array.
  addAudioTrack(project, 'Riser');
  const audioIdx = project.tracks.length - 1;
  const bytes = synthesizeRiserWav();
  try {
    await deps.importAssetIntoTrack(audioIdx, bytes, 'demo-riser.wav');
  } catch (err) {
    console.warn('demo riser import failed:', err);
  }
  // Subtle in the mix — the bass + drums carry the energy.
  setTrackGain(project, audioIdx, 0.6);
  setTrackColor(project, audioIdx, TRACK_PALETTE[2]); // yellow

  // Phase-10 M3b — bake in a 0.25 s fade-in + 0.5 s fade-out so the
  // riser ramps up + tails off audibly, and so the cumulative demo
  // exercises the fade-overlay rendering path. 48 kHz sample rate ×
  // duration in seconds.
  setAudioRegionFade(project, audioIdx, 0, 'in',  Math.round(0.25 * 48_000));
  setAudioRegionFade(project, audioIdx, 0, 'out', Math.round(0.50 * 48_000));
}

/// Phase-10 P6 — drop the real `bell.wav` (44.1 kHz, served from
/// /demo-assets) onto its own Audio track, alongside the synth riser.
/// Proves the cumulative demo decodes a real on-disk file, not just a
/// generated buffer. Failures are non-fatal — the riser still carries
/// the audio path if the fetch is blocked.
async function enrichWithBellSample(
  project: Project,
  deps: DemoEnrichmentDeps,
): Promise<void> {
  addAudioTrack(project, 'Bell');
  const audioIdx = project.tracks.length - 1;
  let hash: string;
  try {
    const res = await fetch('/demo-assets/bell.wav');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    ({ hash } = await deps.importAssetIntoTrack(audioIdx, bytes, 'bell.wav'));
  } catch (err) {
    console.warn('demo bell import failed:', err);
    return;
  }
  setTrackGain(project, audioIdx, 0.7);
  setTrackColor(project, audioIdx, TRACK_PALETTE[4]); // distinct from the riser

  // Fades derived from the asset's *real* sample rate (bell.wav is
  // 44.1 kHz, not the engine's 48 kHz default) — see the no-hard-coded-
  // sample-rate rule. Skip silently if metadata isn't ready.
  const sr = getAssetMetadata(project, hash)?.sampleRate;
  if (sr && getAudioRegions(project, audioIdx).length > 0) {
    setAudioRegionFade(project, audioIdx, 0, 'in',  Math.round(0.05 * sr));
    setAudioRegionFade(project, audioIdx, 0, 'out', Math.round(0.30 * sr));
  }
}

/// Generate a 2 s 48 kHz mono pad-riser WAV (RIFF + 16-bit PCM).
/// Pitch sweeps from C2 (65 Hz) up two octaves with a soft attack
/// and exponential decay so it reads as a transition effect rather
/// than a melodic note.
function synthesizeRiserWav(): Uint8Array {
  const sampleRate = 48000;
  const seconds = 2;
  const frames = sampleRate * seconds;
  const blockAlign = 2;
  const dataSize = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  let p = 0;
  const setStr = (s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i));
    p += s.length;
  };
  const setU32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
  const setU16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
  setStr('RIFF'); setU32(36 + dataSize); setStr('WAVE');
  setStr('fmt '); setU32(16); setU16(1); setU16(1);
  setU32(sampleRate); setU32(sampleRate * blockAlign);
  setU16(blockAlign); setU16(16);
  setStr('data'); setU32(dataSize);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    const freq = 65 * Math.pow(4, t); // C2 → C4 over 2 s
    phase += (2 * Math.PI * freq) / sampleRate;
    // Soft attack (~0.3 s) + long tail. Combine fundamental with
    // a quieter octave so the texture feels less pure.
    const env = Math.min(t / 0.15, 1) * Math.exp(-2.5 * t);
    const sample = (Math.sin(phase) * 0.6 + Math.sin(phase * 2) * 0.3) * env * 0.55;
    dv.setInt16(p, Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), true);
    p += 2;
  }
  return new Uint8Array(ab);
}
