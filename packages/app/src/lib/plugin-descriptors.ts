// JS-side mirror of plugin parameter descriptors. The wire shape (id /
// name / min / max / default / unit / curve / group) matches
// `crates/audio-engine/src/plugin.rs::ParamDescriptor`. Mirroring is
// acceptable for first-party plugins in Phase 2; Phase 7 introduces
// the public SDK and shifts descriptors to engine-shipped postcard
// blobs so third-party plugins don't need a JS twin.

export type ParamCurve = 'linear' | 'exp' | 'db';
export type ParamUnit =
  | 'none'
  | 'hz'
  | 'db'
  | 'seconds'
  | 'ms'
  | 'percent'
  | 'semitones'
  | 'cents';

export interface ParamDescriptor {
  id: number;
  name: string;
  min: number;
  max: number;
  default: number;
  unit: ParamUnit;
  curve: ParamCurve;
  group: string;
  /// UI hint for enum-style descriptors. Mirrored to JS only — the
  /// engine doesn't need labels, the UI does.
  options?: string[];
}

// Stable param ids — must match
// crates/audio-engine/src/plugins/subtractive.rs constants.
export const SUB_PID = {
  OSC_A_WAVE: 0,
  OSC_A_DETUNE: 1,
  OSC_B_WAVE: 2,
  OSC_B_DETUNE: 3,
  OSC_MIX: 4,
  FILTER_TYPE: 5,
  FILTER_CUTOFF: 6,
  FILTER_RES: 7,
  FILTER_ENV_AMT: 8,
  AMP_A: 9,
  AMP_D: 10,
  AMP_S: 11,
  AMP_R: 12,
  FILT_A: 13,
  FILT_D: 14,
  FILT_S: 15,
  FILT_R: 16,
  GAIN: 17,
} as const;

const WAVE_OPTS = ['Sine', 'Saw', 'Square'];
const FILTER_OPTS = ['Lowpass', 'Highpass', 'Bandpass'];

export const SUBTRACTIVE_DESCRIPTORS: ParamDescriptor[] = [
  { id: SUB_PID.OSC_A_WAVE,    name: 'Osc A Wave',     min: 0,    max: 2,     default: 0,    unit: 'none',    curve: 'linear', group: 'osc',        options: WAVE_OPTS },
  { id: SUB_PID.OSC_A_DETUNE,  name: 'Osc A Detune',   min: -100, max: 100,   default: 0,    unit: 'cents',   curve: 'linear', group: 'osc' },
  { id: SUB_PID.OSC_B_WAVE,    name: 'Osc B Wave',     min: 0,    max: 2,     default: 1,    unit: 'none',    curve: 'linear', group: 'osc',        options: WAVE_OPTS },
  { id: SUB_PID.OSC_B_DETUNE,  name: 'Osc B Detune',   min: -100, max: 100,   default: 7,    unit: 'cents',   curve: 'linear', group: 'osc' },
  { id: SUB_PID.OSC_MIX,       name: 'Osc Mix',        min: 0,    max: 1,     default: 0.5,  unit: 'none',    curve: 'linear', group: 'osc' },
  { id: SUB_PID.FILTER_TYPE,   name: 'Filter Type',    min: 0,    max: 2,     default: 0,    unit: 'none',    curve: 'linear', group: 'filter',     options: FILTER_OPTS },
  { id: SUB_PID.FILTER_CUTOFF, name: 'Cutoff',         min: 20,   max: 20000, default: 2000, unit: 'hz',      curve: 'exp',    group: 'filter' },
  { id: SUB_PID.FILTER_RES,    name: 'Resonance',      min: 0,    max: 1,     default: 0,    unit: 'none',    curve: 'linear', group: 'filter' },
  { id: SUB_PID.FILTER_ENV_AMT,name: 'Env Amount',     min: -4,   max: 4,     default: 0,    unit: 'none',    curve: 'linear', group: 'filter' },
  { id: SUB_PID.AMP_A,         name: 'Amp Attack',     min: 0.001,max: 5,     default: 0.005,unit: 'seconds', curve: 'exp',    group: 'amp' },
  { id: SUB_PID.AMP_D,         name: 'Amp Decay',      min: 0.001,max: 5,     default: 0.1,  unit: 'seconds', curve: 'exp',    group: 'amp' },
  { id: SUB_PID.AMP_S,         name: 'Amp Sustain',    min: 0,    max: 1,     default: 0.7,  unit: 'none',    curve: 'linear', group: 'amp' },
  { id: SUB_PID.AMP_R,         name: 'Amp Release',    min: 0.001,max: 5,     default: 0.2,  unit: 'seconds', curve: 'exp',    group: 'amp' },
  { id: SUB_PID.FILT_A,        name: 'Filter Attack',  min: 0.001,max: 5,     default: 0.005,unit: 'seconds', curve: 'exp',    group: 'filter_env' },
  { id: SUB_PID.FILT_D,        name: 'Filter Decay',   min: 0.001,max: 5,     default: 0.2,  unit: 'seconds', curve: 'exp',    group: 'filter_env' },
  { id: SUB_PID.FILT_S,        name: 'Filter Sustain', min: 0,    max: 1,     default: 0.5,  unit: 'none',    curve: 'linear', group: 'filter_env' },
  { id: SUB_PID.FILT_R,        name: 'Filter Release', min: 0.001,max: 5,     default: 0.3,  unit: 'seconds', curve: 'exp',    group: 'filter_env' },
  { id: SUB_PID.GAIN,          name: 'Gain',           min: 0,    max: 1,     default: 0.5,  unit: 'none',    curve: 'linear', group: 'amp' },
];

export const GROUP_LABELS: Record<string, string> = {
  osc: 'Oscillators',
  filter: 'Filter',
  filter_env: 'Filter Envelope',
  amp: 'Amp',
};

/// Map a 0..127 MIDI CC value to a parameter value, honouring the
/// descriptor's curve (linear or exponential). Exponential maps lift
/// frequency-like params so 1 kHz sits near the middle of a 20 Hz..
/// 20 kHz range.
export function scaleCcToParam(d: ParamDescriptor, ccValue: number): number {
  const pos = Math.max(0, Math.min(1, ccValue / 127));
  if (d.curve === 'exp' && d.min > 0) {
    return d.min * Math.pow(d.max / d.min, pos);
  }
  return d.min + (d.max - d.min) * pos;
}

export function descriptorById(
  list: ParamDescriptor[],
  id: number,
): ParamDescriptor | null {
  return list.find((d) => d.id === id) ?? null;
}

// ---- Phase-4 M1: Gain descriptors ----------------------------------

export const GAIN_DESCRIPTORS: ParamDescriptor[] = [
  { id: 0, name: 'Gain', min: 0, max: 2, default: 1, unit: 'none', curve: 'linear', group: 'gain' },
];

// ---- Phase-4 M3: 4 first-party effects -----------------------------

const ENABLE_OPTS = ['Off', 'On'];

function band(prefix: string, group: string, baseId: number, freqDefault: number, qDefault: number): ParamDescriptor[] {
  return [
    { id: baseId,     name: `${prefix} Freq`, min: 20,    max: 20000, default: freqDefault, unit: 'hz',   curve: 'exp',    group },
    { id: baseId + 1, name: `${prefix} Gain`, min: -24,   max: 24,    default: 0,           unit: 'db',   curve: 'linear', group },
    { id: baseId + 2, name: `${prefix} Q`,    min: 0.1,   max: 10,    default: qDefault,    unit: 'none', curve: 'exp',    group },
    { id: baseId + 3, name: `${prefix} On`,   min: 0,     max: 1,     default: 1,           unit: 'none', curve: 'linear', group, options: ENABLE_OPTS },
  ];
}

export const EQ_DESCRIPTORS: ParamDescriptor[] = [
  ...band('Lo',  'lo',     0,  100,  0.707),
  ...band('LM',  'lo_mid', 4,  400,  1.0),
  ...band('HM',  'hi_mid', 8,  2000, 1.0),
  ...band('Hi',  'hi',     12, 8000, 0.707),
];

export const COMPRESSOR_DESCRIPTORS: ParamDescriptor[] = [
  { id: 0, name: 'Threshold', min: -60,    max: 0,   default: -18,    unit: 'db',      curve: 'linear', group: 'comp' },
  { id: 1, name: 'Ratio',     min: 1,      max: 20,  default: 4,      unit: 'none',    curve: 'exp',    group: 'comp' },
  { id: 2, name: 'Attack',    min: 0.001,  max: 0.5, default: 0.005,  unit: 'seconds', curve: 'exp',    group: 'comp' },
  { id: 3, name: 'Release',   min: 0.01,   max: 2,   default: 0.1,    unit: 'seconds', curve: 'exp',    group: 'comp' },
  { id: 4, name: 'Makeup',    min: 0,      max: 24,  default: 0,      unit: 'db',      curve: 'linear', group: 'comp' },
  { id: 5, name: 'Knee',      min: 0,      max: 12,  default: 6,      unit: 'db',      curve: 'linear', group: 'comp' },
];

export const REVERB_DESCRIPTORS: ParamDescriptor[] = [
  { id: 0, name: 'Pre-Delay', min: 0, max: 100, default: 10,  unit: 'ms',   curve: 'linear', group: 'rev' },
  { id: 1, name: 'Room',      min: 0, max: 1,   default: 0.7, unit: 'none', curve: 'linear', group: 'rev' },
  { id: 2, name: 'Damping',   min: 0, max: 1,   default: 0.4, unit: 'none', curve: 'linear', group: 'rev' },
  { id: 3, name: 'Mix',       min: 0, max: 1,   default: 0.3, unit: 'none', curve: 'linear', group: 'rev' },
];

// Container's branch-gain descriptors. Phase-4 M5 ships with a fixed
// 2-branch shape; the engine supports up to MAX_BRANCHES = 8. The
// descriptor table here covers branches 0..1 by default; if we extend
// to user-configurable branch counts in a Phase-9 polish pass, this
// becomes a per-instance shape (the engine already builds descriptors
// per Container instance).
export const CONTAINER_DESCRIPTORS: ParamDescriptor[] = [
  { id: 0, name: 'Branch 1 Gain', min: 0, max: 2, default: 1, unit: 'none', curve: 'linear', group: 'container' },
  { id: 1, name: 'Branch 2 Gain', min: 0, max: 2, default: 1, unit: 'none', curve: 'linear', group: 'container' },
];

// ---- Phase-8 M2: Drumkit (5-voice TR-style drum machine) -----------
//
// Stable param ids — mirror
// crates/audio-engine/src/plugins/drumkit.rs constants. The mapping
// is also re-exported from project.ts as DRUMKIT_PID_* for callers
// that don't need the full descriptor table.

export const DRUMKIT_PID = {
  KICK_LEVEL: 0,
  KICK_TUNE: 1,
  KICK_DECAY: 2,
  SNARE_LEVEL: 3,
  SNARE_TUNE: 4,
  SNARE_DECAY: 5,
  CLAP_LEVEL: 6,
  CLAP_DECAY: 7,
  CHAT_LEVEL: 8,
  CHAT_DECAY: 9,
  OHAT_LEVEL: 10,
  OHAT_DECAY: 11,
  GAIN: 12,
} as const;

export const DRUMKIT_DESCRIPTORS: ParamDescriptor[] = [
  { id: DRUMKIT_PID.KICK_LEVEL,  name: 'Kick Level',       min: 0,     max: 1,    default: 0.8,  unit: 'none',      curve: 'linear', group: 'kick' },
  { id: DRUMKIT_PID.KICK_TUNE,   name: 'Kick Tune',        min: -12,   max: 12,   default: 0,    unit: 'semitones', curve: 'linear', group: 'kick' },
  { id: DRUMKIT_PID.KICK_DECAY,  name: 'Kick Decay',       min: 0.01,  max: 1.5,  default: 0.30, unit: 'seconds',   curve: 'linear', group: 'kick' },
  { id: DRUMKIT_PID.SNARE_LEVEL, name: 'Snare Level',      min: 0,     max: 1,    default: 0.8,  unit: 'none',      curve: 'linear', group: 'snare' },
  { id: DRUMKIT_PID.SNARE_TUNE,  name: 'Snare Tune',       min: -12,   max: 12,   default: 0,    unit: 'semitones', curve: 'linear', group: 'snare' },
  { id: DRUMKIT_PID.SNARE_DECAY, name: 'Snare Decay',      min: 0.01,  max: 1.5,  default: 0.18, unit: 'seconds',   curve: 'linear', group: 'snare' },
  { id: DRUMKIT_PID.CLAP_LEVEL,  name: 'Clap Level',       min: 0,     max: 1,    default: 0.8,  unit: 'none',      curve: 'linear', group: 'clap' },
  { id: DRUMKIT_PID.CLAP_DECAY,  name: 'Clap Decay',       min: 0.01,  max: 1.5,  default: 0.20, unit: 'seconds',   curve: 'linear', group: 'clap' },
  { id: DRUMKIT_PID.CHAT_LEVEL,  name: 'Closed Hat Level', min: 0,     max: 1,    default: 0.8,  unit: 'none',      curve: 'linear', group: 'hat' },
  { id: DRUMKIT_PID.CHAT_DECAY,  name: 'Closed Hat Decay', min: 0.01,  max: 1.5,  default: 0.05, unit: 'seconds',   curve: 'linear', group: 'hat' },
  { id: DRUMKIT_PID.OHAT_LEVEL,  name: 'Open Hat Level',   min: 0,     max: 1,    default: 0.8,  unit: 'none',      curve: 'linear', group: 'hat' },
  { id: DRUMKIT_PID.OHAT_DECAY,  name: 'Open Hat Decay',   min: 0.01,  max: 1.5,  default: 0.30, unit: 'seconds',   curve: 'linear', group: 'hat' },
  { id: DRUMKIT_PID.GAIN,        name: 'Master Gain',      min: 0,     max: 1,    default: 0.8,  unit: 'none',      curve: 'linear', group: 'master' },
];

export const DELAY_DESCRIPTORS: ParamDescriptor[] = [
  { id: 0, name: 'Time',     min: 1,   max: 2000,  default: 250,  unit: 'ms',   curve: 'exp',    group: 'delay' },
  { id: 1, name: 'Feedback', min: 0,   max: 0.95,  default: 0.4,  unit: 'none', curve: 'linear', group: 'delay' },
  { id: 2, name: 'High Cut', min: 200, max: 20000, default: 8000, unit: 'hz',   curve: 'exp',    group: 'delay' },
  { id: 3, name: 'Low Cut',  min: 20,  max: 2000,  default: 100,  unit: 'hz',   curve: 'exp',    group: 'delay' },
  { id: 4, name: 'Mix',      min: 0,   max: 1,     default: 0.3,  unit: 'none', curve: 'linear', group: 'delay' },
];
