<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { PipBindings } from './pip';

  const { bindings }: { bindings: PipBindings } = $props();

  let playing = $state(untrack(() => bindings.getPlaying()));
  let bpm = $state(untrack(() => bindings.getBpm()));
  let projectName = $state(untrack(() => bindings.getProjectName()));

  onMount(() => {
    // PIP windows can't share Svelte reactivity with the opener, so
    // we poll the bindings. 100 ms is human-perceptual; tighter is
    // wasted work for a transport panel.
    const id = setInterval(() => {
      playing = bindings.getPlaying();
      bpm = bindings.getBpm();
      projectName = bindings.getProjectName();
    }, 100);
    return () => clearInterval(id);
  });

  function toggle() {
    if (playing) bindings.stop();
    else bindings.play();
  }
</script>

<div class="pip">
  <button class="play" data-testid="pip-play" onclick={toggle} aria-pressed={playing}>
    {playing ? 'Stop' : 'Play'}
  </button>
  <div class="meta">
    <span class="name">{projectName}</span>
    <span class="bpm">{bpm.toFixed(0)} BPM</span>
  </div>
</div>

<style>
  /* Component is mounted into the PIP window's body via lib/pip.ts;
     pip.ts injects a one-shot stylesheet covering html / body (Svelte
     scopes <style> blocks per-component, so :global would leak the
     sheet into the main app build). */
  .pip {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    height: 100vh;
    box-sizing: border-box;
    background: linear-gradient(180deg, #1a1a1a, #0d0d0d);
    border: 1px solid #2a2a2a;
  }
  .play {
    background: #ff8c00;
    color: #1a0d00;
    border: none;
    padding: 8px 18px;
    font: 600 14px system-ui, sans-serif;
    cursor: pointer;
    border-radius: 4px;
  }
  .play:hover {
    filter: brightness(1.1);
  }
  .play[aria-pressed='true'] {
    background: #ff3a3a;
    color: #fff;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    color: #ddd;
    font-weight: 600;
  }
  .bpm {
    color: #888;
    font: 11px ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
  }
</style>
