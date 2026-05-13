<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as Y from 'yjs';
  import {
    type Project,
    setSynthParam,
    getSynthParam,
    getTrackPluginId,
    getTrackName,
    listMidiBindings,
  } from './project';
  import { getDescriptors, isHostRendered } from './plugin-host';
  import {
    GROUP_LABELS,
    type ParamDescriptor,
  } from './plugin-descriptors';
  import ParamControl from './ui/ParamControl.svelte';
  import ADSRShape from './ui/ADSRShape.svelte';

  const {
    project,
    trackIdx,
    learnActive = false,
    learnPendingCC = null,
    onBindParam = () => {},
    onUnbindCC = () => {},
  }: {
    project: Project;
    trackIdx: number;
    learnActive?: boolean;
    learnPendingCC?: number | null;
    onBindParam?: (paramId: number) => void;
    onUnbindCC?: (cc: number) => void;
  } = $props();

  let pluginId = $state(untrack(() => getTrackPluginId(project, trackIdx)));
  let values = $state<Record<number, number>>(untrack(() => snapshotValues()));
  let bindings = $state<Map<number, number>>(untrack(() => snapshotBindings()));

  function snapshotBindings(): Map<number, number> {
    const out = new Map<number, number>();
    for (const { cc, binding } of listMidiBindings(project)) {
      if (binding.trackIdx === trackIdx) out.set(binding.paramId, cc);
    }
    return out;
  }

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
      bindings = snapshotBindings();
    };

    const onMeta = () => {
      bindings = snapshotBindings();
    };
    project.meta.observeDeep(onMeta);

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
      project.meta.unobserveDeep(onMeta);
    };
  });

  function onParamClick(paramId: number) {
    if (learnActive && learnPendingCC != null) {
      onBindParam(paramId);
    }
  }

  function commitParam(d: ParamDescriptor, v: number) {
    setSynthParam(project, trackIdx, d.id, v);
  }

  /// Detect A/D/S/R param sets inside a group so we can prepend an
  /// envelope-shape view. Matches by case-insensitive name suffix —
  /// works for "Amp Attack", "Filter Attack", etc.
  function adsrFor(items: ParamDescriptor[]): {
    a: ParamDescriptor; d: ParamDescriptor; s: ParamDescriptor; r: ParamDescriptor;
  } | null {
    const byTail = (suffix: string) =>
      items.find((p) => p.name.toLowerCase().endsWith(suffix));
    const a = byTail('attack');
    const d = byTail('decay');
    const s = byTail('sustain');
    const r = byTail('release');
    if (a && d && s && r) return { a, d, s, r };
    return null;
  }

  /// Friendly display name for the header — strip the builtin: prefix
  /// and title-case the rest. Third-party plugins keep their manifest
  /// name (caller can override by setting a custom title at the
  /// PluginPanel mount site later).
  const friendlyName = $derived.by(() => {
    if (!pluginId) return '';
    const base = pluginId.replace(/^builtin:/, '');
    return base.charAt(0).toUpperCase() + base.slice(1);
  });

  const trackNameValue = $derived.by(() => {
    if (!project) return '';
    if (trackIdx < 0 || trackIdx >= project.tracks.length) return '';
    return getTrackName(project, trackIdx);
  });
</script>

{#if pluginId && isHostRendered(pluginId)}
  <section class="panel" data-testid="plugin-panel">
    <header class="panel-head">
      <div class="panel-head-l">
        <span class="panel-title">{friendlyName}</span>
        <span class="panel-preset" data-testid="plugin-preset">Default</span>
      </div>
      <span class="panel-track">{trackNameValue}</span>
    </header>
    <div class="groups">
      {#each groups as g}
        {@const adsr = adsrFor(g.items)}
        <section class="group" data-testid={`plugin-group-${g.name}`}>
          <header class="group-head">{g.label}</header>
          {#if adsr}
            <ADSRShape
              attack={values[adsr.a.id] ?? adsr.a.default}
              decay={values[adsr.d.id] ?? adsr.d.default}
              sustain={values[adsr.s.id] ?? adsr.s.default}
              release={values[adsr.r.id] ?? adsr.r.default}
              width={200}
              height={56}
            />
          {/if}
          <div class="controls" class:knobby={g.items.some((d) => {
            return d.curve === 'exp' || d.unit === 'hz';
          })}>
            {#each g.items as d (d.id)}
              <ParamControl
                descriptor={d}
                value={values[d.id] ?? d.default}
                boundCC={bindings.get(d.id)}
                learnActive={learnActive && learnPendingCC != null}
                onChange={(v) => commitParam(d, v)}
                onLearnClick={onBindParam}
                onUnbindCC={onUnbindCC}
              />
            {/each}
          </div>
        </section>
      {/each}
    </div>
  </section>
{/if}

<style>
  .panel {
    background: var(--bg-2);
    border: 1px solid var(--line-1);
    border-radius: var(--r-md);
    color: var(--fg-1);
    font-family: var(--font-sans);
    font-size: var(--text-12);
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--line-1);
    background: var(--bg-1);
  }
  .panel-head-l {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
  }
  .panel-title {
    font-family: var(--font-mono);
    font-size: var(--text-12);
    font-weight: 600;
    color: var(--fg-0);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .panel-preset {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
    border: 1px solid var(--line-2);
    background: var(--bg-0);
    padding: 1px 6px;
    border-radius: var(--r-sm);
  }
  .panel-track {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--sp-3);
    padding: var(--sp-3);
  }
  .group {
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .group-head {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-bottom: 1px solid var(--line-0);
    padding-bottom: var(--sp-2);
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
</style>
