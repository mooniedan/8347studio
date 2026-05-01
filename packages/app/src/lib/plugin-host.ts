// Plugin descriptor registry. Tiny in Phase 2 — just the first-party
// subtractive synth. Phase 7 turns this into a real loader: fetch the
// plugin manifest, instantiate the WASM module, register its descriptors
// here so the host UI can render the panel without the plugin's own JS.

import { SUBTRACTIVE_DESCRIPTORS, type ParamDescriptor } from './plugin-descriptors';

export type PluginId = 'builtin:oscillator' | 'builtin:subtractive';

const REGISTRY: Record<string, ParamDescriptor[]> = {
  'builtin:subtractive': SUBTRACTIVE_DESCRIPTORS,
};

export function getDescriptors(pluginId: string): ParamDescriptor[] | null {
  return REGISTRY[pluginId] ?? null;
}

export function isHostRendered(pluginId: string): boolean {
  return REGISTRY[pluginId] != null;
}
