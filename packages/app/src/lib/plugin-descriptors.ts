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
