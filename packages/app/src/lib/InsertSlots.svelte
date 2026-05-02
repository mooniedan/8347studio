<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    addInsert,
    getTrackInserts,
    removeInsert,
    setInsertBypass,
    setInsertParam,
    type InsertView,
    type Project,
  } from './project';

  const { project, trackIdx }: { project: Project; trackIdx: number } = $props();

  let inserts = $state<InsertView[]>(untrack(() => getTrackInserts(project, trackIdx)));

  function refresh() {
    inserts = getTrackInserts(project, trackIdx);
  }

  $effect(() => {
    const idx = trackIdx;
    inserts = getTrackInserts(project, idx);
    project.trackById.observeDeep(refresh);
    project.tracks.observe(refresh);
    return () => {
      project.trackById.unobserveDeep(refresh);
      project.tracks.unobserve(refresh);
    };
  });

  function onAddGain() {
    addInsert(project, trackIdx, 'builtin:gain');
  }

  function onRemove(slotIdx: number) {
    removeInsert(project, trackIdx, slotIdx);
  }

  function onBypass(slotIdx: number, value: boolean) {
    setInsertBypass(project, trackIdx, slotIdx, value);
  }

  function onGainInput(slotIdx: number, ev: Event) {
    const v = Number((ev.target as HTMLInputElement).value);
    setInsertParam(project, trackIdx, slotIdx, 0, v);
  }

  function labelFor(kind: string): string {
    if (kind === 'builtin:gain') return 'Gain';
    return kind;
  }
</script>

<section class="inserts" data-testid="insert-slots">
  <header class="head">
    <span class="title">Inserts</span>
    <button class="add" data-testid="insert-add-gain" onclick={onAddGain}>+ Gain</button>
  </header>
  {#if inserts.length === 0}
    <div class="empty">No inserts on this track.</div>
  {:else}
    <ol>
      {#each inserts as ins, i (i)}
        <li class="slot" class:bypass={ins.bypass} data-testid={`insert-slot-${i}`}>
          <span class="kind">{labelFor(ins.kind)}</span>
          {#if ins.kind === 'builtin:gain'}
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={ins.params[0] ?? 1.0}
              oninput={(e) => onGainInput(i, e)}
              data-testid={`insert-${i}-gain`}
              aria-label="Insert gain"
            />
            <span class="readout" data-testid={`insert-${i}-gain-value`}>{(ins.params[0] ?? 1.0).toFixed(2)}</span>
          {/if}
          <button
            class="bypass"
            class:on={ins.bypass}
            data-testid={`insert-${i}-bypass`}
            onclick={() => onBypass(i, !ins.bypass)}
            title="Bypass"
          >
            {ins.bypass ? 'BYP' : 'On'}
          </button>
          <button
            class="del"
            data-testid={`insert-${i}-remove`}
            onclick={() => onRemove(i)}
            aria-label="Remove insert"
          >×</button>
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
  .add {
    background: #1a1a1a;
    color: #ddd;
    border: 1px dashed #2a2a2a;
    padding: 2px 8px;
    font: inherit;
    cursor: pointer;
  }
  .add:hover {
    background: #232323;
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
    display: grid;
    grid-template-columns: auto 1fr auto auto auto;
    gap: 8px;
    align-items: center;
    background: #181818;
    border: 1px solid #2a2a2a;
    padding: 4px 6px;
  }
  .slot.bypass {
    opacity: 0.6;
  }
  .kind {
    color: #ddd;
    font-weight: 600;
  }
  .readout {
    color: #888;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
  }
  .bypass,
  .del {
    appearance: none;
    background: transparent;
    color: #888;
    border: 1px solid #2a2a2a;
    padding: 2px 6px;
    font: inherit;
    cursor: pointer;
  }
  .bypass.on {
    background: #2a1f0a;
    color: #ffb84a;
    border-color: #5a3f10;
  }
  .del:hover {
    color: #f55;
  }
  input[type='range'] {
    width: 120px;
    accent-color: #ff8c00;
  }
</style>
