<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    addMidiTrack,
    removeTrack,
    getTrackName,
    getTrackColor,
    getArmedTrackId,
    setArmedTrackId,
    type Project,
  } from './project';

  import type { CollabState } from './collab.svelte';

  const {
    project,
    selectedIdx,
    onSelect,
    collab = null,
  }: {
    project: Project;
    selectedIdx: number;
    onSelect: (idx: number) => void;
    /// Phase-9 M4 — when set, render ghost rings on tracks remote
    /// peers have selected. Each peer paints in their own color.
    collab?: CollabState | null;
  } = $props();

  // Reactive derivation — for each row, the list of peers whose
  // `selectedTrackIdx` matches.
  function peersOn(rowIdx: number): { id: number; color: string; name: string }[] {
    if (!collab) return [];
    const out: { id: number; color: string; name: string }[] = [];
    for (const p of collab.peers) {
      if (p.state.selectedTrackIdx === rowIdx && p.state.user) {
        out.push({ id: p.id, color: p.state.user.color, name: p.state.user.name });
      }
    }
    return out;
  }

  let tracks = $state<{ id: string; name: string; color: string }[]>(snapshot());
  let armedId = $state<string | null>(untrack(() => getArmedTrackId(project)));

  function snapshot() {
    const out: { id: string; name: string; color: string }[] = [];
    for (let i = 0; i < project.tracks.length; i++) {
      const id = project.tracks.get(i);
      out.push({ id, name: getTrackName(project, i), color: getTrackColor(project, i) });
    }
    return out;
  }

  onMount(() => {
    const refresh = () => {
      tracks = snapshot();
    };
    project.tracks.observe(refresh);
    project.trackById.observeDeep(refresh);

    const onMeta = () => {
      armedId = getArmedTrackId(project);
    };
    project.meta.observe(onMeta);

    return () => {
      project.tracks.unobserve(refresh);
      project.trackById.unobserveDeep(refresh);
      project.meta.unobserve(onMeta);
    };
  });

  function toggleArm(id: string) {
    setArmedTrackId(project, armedId === id ? null : id);
  }

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
    {@const rowPeers = peersOn(i)}
    {@const isLocal = i === selectedIdx}
    <div
      class="row"
      class:selected={isLocal}
      class:peer-selected={rowPeers.length > 0}
      class:contended={isLocal && rowPeers.length > 0}
      class:armed={armedId === t.id}
      style:--peer-color={rowPeers[0]?.color ?? 'transparent'}
      onclick={() => onSelect(i)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } }}
      role="button"
      tabindex="0"
      data-testid={`track-row-${i}`}
    >
      <span class="stripe" style="background:{t.color}"></span>
      <span class="name">{t.name}</span>
      {#if rowPeers.length > 0}
        <span
          class="peer-marker"
          data-testid={`track-peer-marker-${i}`}
          title={rowPeers.map((p) => p.name).join(', ')}
          aria-label={`Peers viewing this track: ${rowPeers.map((p) => p.name).join(', ')}`}
        >
          {#each rowPeers as p (p.id)}
            <span class="peer-dot" style:background={p.color}></span>
          {/each}
        </span>
      {/if}
      <button
        class="arm"
        class:armed={armedId === t.id}
        onclick={(e) => { e.stopPropagation(); toggleArm(t.id); }}
        data-testid={`track-arm-${i}`}
        aria-label={`arm ${t.name}`}
        title="Arm for live MIDI input"
      >●</button>
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
  /* Phase-9 M4 — ghost border in the peer's color when a remote
     peer has this row selected. Layered under .selected so the
     local selection takes visual precedence. */
  .row.peer-selected { box-shadow: inset 0 0 0 1px var(--peer-color); }
  /* Phase-9 M6 — when we and a peer are both on the same row, the
     border thickens so the user clocks the contention immediately,
     and the local background softens so the peer color reads as
     the dominant signal. */
  .row.contended {
    box-shadow: inset 0 0 0 2px var(--peer-color);
    background: #1a1a1a;
  }
  /* Phase-10 M5 — armed track glow. The row gets a warm border +
     subtle pulsing background so it's clear at a glance which track
     is going to receive the next take. Peer / selection box-shadows
     still win when both are active because they specify `inset`. */
  .row.armed {
    border-color: #ff5a3a;
    background: #1f0e0a;
    animation: arm-pulse 1.6s ease-in-out infinite;
  }
  @keyframes arm-pulse {
    0%, 100% { background: #1f0e0a; }
    50%      { background: #2a120c; }
  }
  .peer-marker {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-right: 4px;
  }
  .peer-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .stripe { width: 8px; height: 14px; border-radius: 2px; }
  .name { flex: 1; }
  .arm {
    appearance: none; background: transparent; border: 1px solid #2a2a2a; color: #555;
    cursor: pointer; padding: 0 4px; font-size: 10px; line-height: 1;
    border-radius: 8px; min-width: 14px; height: 14px;
  }
  .arm:hover { color: #ff8c00; border-color: #ff8c00; }
  .arm.armed { color: #ff3a3a; border-color: #ff3a3a; background: #2a0e0e; }
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
