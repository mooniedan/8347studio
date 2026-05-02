// Plugin descriptor registry. Tiny in Phase 2 — just the first-party
// subtractive synth. Phase 7 turns this into a real loader: fetch the
// plugin manifest, instantiate the WASM module, register its descriptors
// here so the host UI can render the panel without the plugin's own JS.

import {
  COMPRESSOR_DESCRIPTORS,
  CONTAINER_DESCRIPTORS,
  DELAY_DESCRIPTORS,
  EQ_DESCRIPTORS,
  GAIN_DESCRIPTORS,
  REVERB_DESCRIPTORS,
  SUBTRACTIVE_DESCRIPTORS,
  type ParamDescriptor,
} from './plugin-descriptors';

export type PluginId =
  | 'builtin:oscillator'
  | 'builtin:subtractive'
  | 'builtin:gain'
  | 'builtin:eq'
  | 'builtin:compressor'
  | 'builtin:reverb'
  | 'builtin:delay'
  | 'builtin:container';

const REGISTRY: Record<string, ParamDescriptor[]> = {
  'builtin:subtractive': SUBTRACTIVE_DESCRIPTORS,
  'builtin:gain': GAIN_DESCRIPTORS,
  'builtin:eq': EQ_DESCRIPTORS,
  'builtin:compressor': COMPRESSOR_DESCRIPTORS,
  'builtin:reverb': REVERB_DESCRIPTORS,
  'builtin:delay': DELAY_DESCRIPTORS,
  'builtin:container': CONTAINER_DESCRIPTORS,
};

export const INSERT_PLUGIN_LABELS: Record<string, string> = {
  'builtin:gain': 'Gain',
  'builtin:eq': 'EQ',
  'builtin:compressor': 'Comp',
  'builtin:reverb': 'Reverb',
  'builtin:delay': 'Delay',
  'builtin:container': 'Container',
};

export const INSERT_PLUGIN_ORDER: string[] = [
  'builtin:gain',
  'builtin:eq',
  'builtin:compressor',
  'builtin:reverb',
  'builtin:delay',
  'builtin:container',
];

export function getDescriptors(pluginId: string): ParamDescriptor[] | null {
  return REGISTRY[pluginId] ?? null;
}

export function isHostRendered(pluginId: string): boolean {
  return REGISTRY[pluginId] != null;
}
