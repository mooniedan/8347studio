<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as Y from 'yjs';
  import {
    type Project,
    setSynthParam,
    getSynthParam,
    getTrackPluginId,
  } from './project';
  import { getDescriptors, isHostRendered } from './plugin-host';
  import {
    GROUP_LABELS,
    type ParamDescriptor,
  } from './plugin-descriptors';

  const { project, trackIdx }: { project: Project; trackIdx: number } = $props();

  let pluginId = $state(untrack(() => getTrackPluginId(project, trackIdx)));
  let values = $state<Record<number, number>>(untrack(() => snapshotValues()));

  const descriptors = $derived(pluginId ? (getDescriptors(pluginId) ?? []) : []);
  const groups = $derived(groupDescriptors(descriptors));

  function snapshotValues(): Record<number, number> {
    const id = getTrackPluginId(project, trackIdx);
    const descs = id ? getDescriptors(id) : null;
    if (!descs) return {};
    const out: Record<number, number> = {};
    for (const d of descs) {
      const stored = getSynthParam(project, trackIdx, d.id);
      out[d.id] = stored ?? d.default;
    }
    return out;
  }

  function groupDescriptors(list: ParamDescriptor[]): { name: string; label: string; items: ParamDescriptor[] }[] {
    const seen = new Map<string, ParamDescriptor[]>();
    for (const d of list) {
      let arr = seen.get(d.group);
      if (!arr) {
        arr = [];
        seen.set(d.group, arr);
      }
      arr.push(d);
    }
    return [...seen.entries()].map(([name, items]) => ({
      name,
      label: GROUP_LABELS[name] ?? name,
      items,
    }));
  }

  onMount(() => {
    const refreshAll = () => {
      pluginId = getTrackPluginId(project, trackIdx);
      values = snapshotValues();
    };

    // Track structure changes (instrument swap on this track).
    const offTrack = () => {};
    project.trackById.observeDeep(refreshAll);

    // Bind to the params map so individual edits update local state
    // without rebuilding the whole values object.
    let unobserveParams: (() => void) | null = null;
    const bindParams = () => {
      unobserveParams?.();
      unobserveParams = null;
      const id = trackIdx >= 0 && trackIdx < project.tracks.length
        ? project.tracks.get(trackIdx)
        : null;
      if (!id) return;
      const track = project.trackById.get(id);
      const instr = track?.get('instrumentSlot') as Y.Map<unknown> | undefined;
      const params = instr?.get('params') as Y.Map<unknown> | undefined;
      if (!params) return;
      const handler = (ev: Y.YMapEvent<unknown>) => {
        ev.changes.keys.forEach((_change, key) => {
          const idNum = parseInt(key, 10);
          if (Number.isNaN(idNum)) return;
          const v = params.get(key);
          if (typeof v === 'number') {
            values = { ...values, [idNum]: v };
          }
        });
      };
      params.observe(handler);
      unobserveParams = () => params.unobserve(handler);
    };
    bindParams();
    const onStructure = () => {
      refreshAll();
      bindParams();
    };
    project.tracks.observe(onStructure);

    return () => {
      offTrack();
      unobserveParams?.();
      project.tracks.unobserve(onStructure);
      project.trackById.unobserveDeep(refreshAll);
    };
  });

  // Slider position (0..1) → value. Linear or exponential mapping.
  function posToValue(d: ParamDescriptor, pos: number): number {
    pos = Math.max(0, Math.min(1, pos));
    if (d.curve === 'exp' && d.min > 0) {
      return d.min * Math.pow(d.max / d.min, pos);
    }
    return d.min + (d.max - d.min) * pos;
  }

  function valueToPos(d: ParamDescriptor, value: number): number {
    if (d.curve === 'exp' && d.min > 0) {
      const ratio = value / d.min;
      const span = d.max / d.min;
      return Math.log(ratio) / Math.log(span);
    }
    return (value - d.min) / (d.max - d.min);
  }

  function format(d: ParamDescriptor, v: number): string {
    if (d.options) return d.options[Math.round(v)] ?? String(v);
    if (d.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`;
    if (d.unit === 'seconds') return v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`;
    if (d.unit === 'cents') return `${v.toFixed(0)} ¢`;
    if (d.unit === 'db') return `${v.toFixed(1)} dB`;
    if (d.unit === 'percent') return `${(v * 100).toFixed(0)}%`;
    if (Math.abs(v) < 1) return v.toFixed(2);
    return v.toFixed(2);
  }

  function onSliderInput(d: ParamDescriptor, ev: Event) {
    const pos = Number((ev.target as HTMLInputElement).value);
    const value = posToValue(d, pos);
    setSynthParam(project, trackIdx, d.id, value);
  }

  function onDropdown(d: ParamDescriptor, ev: Event) {
    const value = Number((ev.target as HTMLSelectElement).value);
    setSynthParam(project, trackIdx, d.id, value);
  }
</script>

{#if pluginId && isHostRendered(pluginId)}
  <section class="panel" data-testid="plugin-panel">
    <header class="panel-head">
      <span class="panel-title">{pluginId.replace('builtin:', '')}</span>
    </header>
    <div class="groups">
      {#each groups as g}
        <div class="group" data-testid={`plugin-group-${g.name}`}>
          <div class="group-label">{g.label}</div>
          <div class="controls">
            {#each g.items as d (d.id)}
              {@const v = values[d.id] ?? d.default}
              <label class="control" data-testid={`param-${d.id}`}>
                <span class="cname">{d.name}</span>
                {#if d.options}
                  <select
                    onchange={(e) => onDropdown(d, e)}
                    value={Math.round(v)}
                    data-testid={`param-${d.id}-input`}
                  >
                    {#each d.options as opt, i}
                      <option value={i}>{opt}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.001"
                    value={valueToPos(d, v)}
                    oninput={(e) => onSliderInput(d, e)}
                    data-testid={`param-${d.id}-input`}
                    aria-label={d.name}
                  />
                {/if}
                <span class="cval" data-testid={`param-${d.id}-value`}>{format(d, v)}</span>
              </label>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .panel {
    background: #131313;
    border: 1px solid #2a2a2a;
    color: #ccc;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    padding: 8px;
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid #2a2a2a;
    padding-bottom: 4px;
    margin-bottom: 8px;
  }
  .panel-title {
    font-weight: 600;
    color: #ddd;
  }
  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .group {
    background: #181818;
    border: 1px solid #2a2a2a;
    padding: 6px;
  }
  .group-label {
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
    font-size: 10px;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .control {
    display: grid;
    grid-template-columns: 1fr 1.2fr 0.7fr;
    gap: 4px;
    align-items: center;
  }
  .cname {
    color: #aaa;
  }
  .cval {
    color: #ddd;
    font-variant-numeric: tabular-nums;
    text-align: right;
    font-size: 10px;
  }
  input[type='range'] {
    width: 100%;
    accent-color: #ff8c00;
  }
  select {
    background: #222;
    color: #ddd;
    border: 1px solid #333;
    font-size: 10px;
    padding: 1px 2px;
  }
</style>
