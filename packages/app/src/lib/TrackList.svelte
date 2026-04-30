<script lang="ts">
  import { onMount } from 'svelte';
  import {
    addMidiTrack,
    removeTrack,
    getTrackName,
    getTrackColor,
    type Project,
  } from './project';

  const {
    project,
    selectedIdx,
    onSelect,
  }: {
    project: Project;
    selectedIdx: number;
    onSelect: (idx: number) => void;
  } = $props();

  let tracks = $state<{ id: string; name: string; color: string }[]>(snapshot());

  function snapshot() {
    const out: { id: string; name: string; color: string }[] = [];
    for (let i = 0; i < project.tracks.length; i++) {
      const id = project.tracks.get(i);
      out.push({ id, name: getTrackName(project, i), color: getTrackColor(project, i) });
    }
    return out;
  }

  onMount(() => {
    const refresh = () => { tracks = snapshot(); };
    project.tracks.observe(refresh);
    project.trackById.observeDeep(refresh);
    return () => {
      project.tracks.unobserve(refresh);
      project.trackById.unobserveDeep(refresh);
    };
  });

  function add() {
    const _id = addMidiTrack(project, 'sine');
    onSelect(project.tracks.length - 1);
  }

  function remove(idx: number) {
    if (project.tracks.length <= 1) return; // keep at least one track
    removeTrack(project, idx);
    if (selectedIdx >= project.tracks.length) {
      onSelect(project.tracks.length - 1);
    }
  }
</script>

<div class="track-list" data-testid="track-list">
  {#each tracks as t, i (t.id)}
    <div
      class="row"
      class:selected={i === selectedIdx}
      onclick={() => onSelect(i)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } }}
      role="button"
      tabindex="0"
      data-testid={`track-row-${i}`}
    >
      <span class="stripe" style="background:{t.color}"></span>
      <span class="name">{t.name}</span>
      {#if tracks.length > 1}
        <button
          class="del"
          onclick={(e) => { e.stopPropagation(); remove(i); }}
          data-testid={`track-delete-${i}`}
          aria-label={`delete ${t.name}`}
        >×</button>
      {/if}
    </div>
  {/each}
  <button class="add" onclick={add} data-testid="add-track">+ Track</button>
</div>

<style>
  .track-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 160px;
    background: #171717;
    border: 1px solid #2a2a2a;
    padding: 4px;
    font-family: system-ui, sans-serif;
    color: #ddd;
    font-size: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .row:hover { background: #222; }
  .row.selected { border-color: #555; background: #1f1f1f; }
  .stripe { width: 8px; height: 14px; border-radius: 2px; }
  .name { flex: 1; }
  .del {
    appearance: none; background: transparent; border: none; color: #888;
    cursor: pointer; padding: 0 4px; font-size: 14px;
  }
  .del:hover { color: #f55; }
  .add {
    margin-top: 4px;
    background: #1f1f1f;
    color: #ccc;
    border: 1px dashed #444;
    padding: 4px 6px;
    cursor: pointer;
    font: inherit;
  }
  .add:hover { background: #262626; color: #fff; }
</style>
