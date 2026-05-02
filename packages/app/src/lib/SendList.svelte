<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    addSend,
    getTrackSends,
    listBusTargets,
    removeSend,
    setSendLevel,
    type Project,
    type SendView,
  } from './project';

  const { project, trackIdx }: { project: Project; trackIdx: number } = $props();

  let sends = $state<SendView[]>(untrack(() => getTrackSends(project, trackIdx)));
  let buses = $state<{ id: string; name: string; idx: number }[]>(
    untrack(() => listBusTargets(project, trackIdx)),
  );

  function refresh() {
    sends = getTrackSends(project, trackIdx);
    buses = listBusTargets(project, trackIdx);
  }

  $effect(() => {
    void trackIdx;
    refresh();
    project.tracks.observe(refresh);
    project.trackById.observeDeep(refresh);
    return () => {
      project.tracks.unobserve(refresh);
      project.trackById.unobserveDeep(refresh);
    };
  });

  function onAddSend(ev: Event) {
    const sel = ev.target as HTMLSelectElement;
    const tid = sel.value;
    if (tid && tid !== '__none__') addSend(project, trackIdx, tid, 0.5);
    sel.value = '__none__';
  }

  function onLevelInput(sendIdx: number, ev: Event) {
    const v = Number((ev.target as HTMLInputElement).value);
    setSendLevel(project, trackIdx, sendIdx, v);
  }

  function onRemove(sendIdx: number) {
    removeSend(project, trackIdx, sendIdx);
  }
</script>

<section class="sends" data-testid="send-list">
  <header class="head">
    <span class="title">Sends</span>
    {#if buses.length > 0}
      <select
        class="add-send"
        data-testid="send-add"
        value="__none__"
        onchange={onAddSend}
      >
        <option value="__none__">+ Send to…</option>
        {#each buses as b}
          <option value={b.id}>{b.name}</option>
        {/each}
      </select>
    {:else}
      <span class="hint">Add a Bus to enable sends.</span>
    {/if}
  </header>
  {#if sends.length === 0}
    <div class="empty">No sends.</div>
  {:else}
    <ol>
      {#each sends as s, i (i)}
        <li class="row" data-testid={`send-${i}`}>
          <span class="target">→ track {s.targetTrackIdx + 1}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={s.level}
            oninput={(e) => onLevelInput(i, e)}
            data-testid={`send-${i}-level`}
            aria-label="Send level"
          />
          <span class="readout" data-testid={`send-${i}-level-value`}>{s.level.toFixed(2)}</span>
          <button
            class="del"
            data-testid={`send-${i}-remove`}
            onclick={() => onRemove(i)}
            aria-label="Remove send"
          >×</button>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .sends {
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
  .add-send {
    background: #1a1a1a;
    color: #ddd;
    border: 1px dashed #2a2a2a;
    padding: 2px 8px;
    font: inherit;
    cursor: pointer;
  }
  .hint {
    color: #666;
    font-style: italic;
    font-size: 10px;
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
  .row {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: 8px;
    align-items: center;
    background: #181818;
    border: 1px solid #2a2a2a;
    padding: 4px 6px;
  }
  .target {
    color: #ddd;
  }
  .readout {
    color: #888;
    font-variant-numeric: tabular-nums;
    font-size: 10px;
  }
  .del {
    appearance: none;
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #888;
    padding: 2px 6px;
    cursor: pointer;
  }
  .del:hover {
    color: #f55;
  }
  input[type='range'] {
    width: 120px;
    accent-color: #4ad6ff;
  }
</style>
