<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    addInsert,
    getTrackInserts,
    removeInsert,
    setInsertBypass,
    setInsertParam,
    type InsertPluginId,
    type InsertView,
    type Project,
  } from './project';
  import {
    getDescriptors,
    INSERT_PLUGIN_LABELS,
    INSERT_PLUGIN_ORDER,
  } from './plugin-host';
  import type { ParamDescriptor } from './plugin-descriptors';

  const { project, trackIdx }: { project: Project; trackIdx: number } = $props();

  let inserts = $state<InsertView[]>(untrack(() => getTrackInserts(project, trackIdx)));

  function refresh() {
    inserts = getTrackInserts(project, trackIdx);
  }

  $effect(() => {
    void trackIdx;
    refresh();
    project.trackById.observeDeep(refresh);
    project.tracks.observe(refresh);
    return () => {
      project.trackById.unobserveDeep(refresh);
      project.tracks.unobserve(refresh);
    };
  });

  function onAddPicker(ev: Event) {
    const sel = ev.target as HTMLSelectElement;
    const pid = sel.value;
    if (pid && pid !== '__none__') {
      addInsert(project, trackIdx, pid as InsertPluginId);
    }
    sel.value = '__none__';
  }

  function onRemove(slotIdx: number) {
    removeInsert(project, trackIdx, slotIdx);
  }

  function onBypass(slotIdx: number, value: boolean) {
    setInsertBypass(project, trackIdx, slotIdx, value);
  }

  function onParamSlider(slotIdx: number, d: ParamDescriptor, ev: Event) {
    const pos = Number((ev.target as HTMLInputElement).value);
    const value =
      d.curve === 'exp' && d.min > 0
        ? d.min * Math.pow(d.max / d.min, pos)
        : d.min + (d.max - d.min) * pos;
    setInsertParam(project, trackIdx, slotIdx, d.id, value);
  }

  function onParamSelect(slotIdx: number, d: ParamDescriptor, ev: Event) {
    const value = Number((ev.target as HTMLSelectElement).value);
    setInsertParam(project, trackIdx, slotIdx, d.id, value);
  }

  function valueToPos(d: ParamDescriptor, value: number): number {
    if (d.curve === 'exp' && d.min > 0) {
      return Math.log(value / d.min) / Math.log(d.max / d.min);
    }
    return (value - d.min) / (d.max - d.min);
  }

  function format(d: ParamDescriptor, v: number): string {
    if (d.options) return d.options[Math.round(v)] ?? String(v);
    if (d.unit === 'hz') return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`;
    if (d.unit === 'seconds') return v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`;
    if (d.unit === 'ms') return `${v.toFixed(0)} ms`;
    if (d.unit === 'db') return `${v.toFixed(1)} dB`;
    return Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(2);
  }

  function valueOrDefault(ins: InsertView, d: ParamDescriptor): number {
    return ins.params[d.id] ?? d.default;
  }
</script>

<section class="inserts" data-testid="insert-slots">
  <header class="head">
    <span class="title">Inserts</span>
    <select
      class="add-pick"
      data-testid="insert-add"
      value="__none__"
      onchange={onAddPicker}
    >
      <option value="__none__">+ Effect…</option>
      {#each INSERT_PLUGIN_ORDER as pid}
        <option value={pid}>{INSERT_PLUGIN_LABELS[pid]}</option>
      {/each}
    </select>
  </header>
  {#if inserts.length === 0}
    <div class="empty">No inserts on this track.</div>
  {:else}
    <ol>
      {#each inserts as ins, i (i)}
        {@const descs = getDescriptors(ins.kind) ?? []}
        <li class="slot" class:bypass={ins.bypass} data-testid={`insert-slot-${i}`}>
          <div class="slot-head">
            <span class="kind">{INSERT_PLUGIN_LABELS[ins.kind] ?? ins.kind}</span>
            <button
              class="bypass-btn"
              class:on={ins.bypass}
              data-testid={`insert-${i}-bypass`}
              onclick={() => onBypass(i, !ins.bypass)}
              title="Bypass"
            >{ins.bypass ? 'BYP' : 'On'}</button>
            <button
              class="del"
              data-testid={`insert-${i}-remove`}
              onclick={() => onRemove(i)}
              aria-label="Remove insert"
            >×</button>
          </div>
          {#if descs.length > 0}
            <div class="params" data-testid={`insert-${i}-params`}>
              {#each descs as d (d.id)}
                {@const v = valueOrDefault(ins, d)}
                <label class="param" data-testid={`insert-${i}-param-${d.id}`}>
                  <span class="cname">{d.name}</span>
                  {#if d.options}
                    <select
                      onchange={(e) => onParamSelect(i, d, e)}
                      value={Math.round(v)}
                      data-testid={`insert-${i}-param-${d.id}-input`}
                    >
                      {#each d.options as opt, oi}
                        <option value={oi}>{opt}</option>
                      {/each}
                    </select>
                  {:else}
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.001"
                      value={valueToPos(d, v)}
                      oninput={(e) => onParamSlider(i, d, e)}
                      data-testid={`insert-${i}-param-${d.id}-input`}
                      aria-label={d.name}
                    />
                  {/if}
                  <span class="cval" data-testid={`insert-${i}-param-${d.id}-value`}>{format(d, v)}</span>
                </label>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .inserts {
    background: #131313;
    border: 1px solid #2a2a2a;
    color: #ccc;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    padding: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .title {
    font-weight: 600;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 10px;
  }
  .add-pick {
    background: #1a1a1a;
    color: #ddd;
    border: 1px dashed #2a2a2a;
    padding: 2px 8px;
    font: inherit;
    cursor: pointer;
  }
  .empty {
    color: #666;
    font-style: italic;
    font-size: 10px;
  }
  ol {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .slot {
    background: #181818;
    border: 1px solid #2a2a2a;
    padding: 4px 6px;
  }
  .slot.bypass {
    opacity: 0.6;
  }
  .slot-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .kind {
    color: #ddd;
    font-weight: 600;
    flex: 1;
  }
  .bypass-btn,
  .del {
    appearance: none;
    background: transparent;
    color: #888;
    border: 1px solid #2a2a2a;
    padding: 2px 6px;
    font: inherit;
    cursor: pointer;
  }
  .bypass-btn.on {
    background: #2a1f0a;
    color: #ffb84a;
    border-color: #5a3f10;
  }
  .del:hover {
    color: #f55;
  }
  .params {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid #2a2a2a;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 4px;
  }
  .param {
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
    padding: 1px 2px;
    font-size: 10px;
  }
</style>
