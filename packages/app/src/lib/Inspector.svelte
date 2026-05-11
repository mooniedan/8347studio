<script lang="ts">
  /**
   * Phase 7 M2/M4 — right-side inspector pane. Shows the selected
   * track's identity + summary metadata. Track-clip-detail editing
   * (audio fade times, MIDI note properties, etc.) is still owned by
   * the per-editor surfaces (AudioTrackView, PianoRoll); the
   * inspector here is the "what is this track" sidebar.
   */
  import { onMount, untrack } from 'svelte';
  import IconButton from './ui/IconButton.svelte';
  import {
    getTrackColor,
    getTrackInserts,
    getTrackName,
    getTrackPluginId,
    getTrackSends,
    setTrackColor,
    setTrackName,
    type Project,
  } from './project';
  import { TRACK_PALETTE } from './track-color';

  let {
    collapsed = $bindable(),
    width = 280,
    project,
    selectedTrackIdx,
  }: {
    collapsed: boolean;
    width?: number;
    project: Project | null;
    selectedTrackIdx: number;
  } = $props();

  type TrackInfo = {
    name: string;
    color: string;
    kind: string;
    pluginId: string | null;
    insertCount: number;
    sendCount: number;
  };

  function snapshot(p: Project, idx: number): TrackInfo | null {
    if (idx < 0 || idx >= p.tracks.length) return null;
    const id = p.tracks.get(idx);
    const t = p.trackById.get(id);
    if (!t) return null;
    return {
      name: getTrackName(p, idx),
      color: getTrackColor(p, idx),
      kind: (t.get('kind') as string | undefined) ?? 'unknown',
      pluginId: getTrackPluginId(p, idx),
      insertCount: getTrackInserts(p, idx).length,
      sendCount: getTrackSends(p, idx).length,
    };
  }

  let info = $state<TrackInfo | null>(
    untrack(() => (project ? snapshot(project, selectedTrackIdx) : null)),
  );

  // Resnapshot on selection change or track-meta updates.
  $effect(() => {
    if (!project) {
      info = null;
      return;
    }
    const idx = selectedTrackIdx;
    info = snapshot(project, idx);
    const refresh = () => { info = project ? snapshot(project, idx) : null; };
    project.trackById.observeDeep(refresh);
    project.tracks.observe(refresh);
    return () => {
      project.trackById.unobserveDeep(refresh);
      project.tracks.unobserve(refresh);
    };
  });

  let nameDraft = $state('');
  $effect(() => { nameDraft = info?.name ?? ''; });

  function commitName() {
    if (!project) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== info?.name) {
      setTrackName(project, selectedTrackIdx, trimmed);
    } else {
      nameDraft = info?.name ?? '';
    }
  }

  function onNameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') { nameDraft = info?.name ?? ''; (e.target as HTMLInputElement).blur(); }
  }

  function pickColor(c: string) {
    if (!project) return;
    setTrackColor(project, selectedTrackIdx, c);
  }
</script>

{#if collapsed}
  <aside
    class="inspector inspector--collapsed"
    data-testid="inspector"
    aria-label="Inspector (collapsed)"
  >
    <IconButton
      ariaLabel="Show inspector"
      title="Show inspector (Cmd/Ctrl+\\)"
      testId="inspector-expand"
      onclick={() => (collapsed = false)}
    >‹</IconButton>
  </aside>
{:else}
  <aside
    class="inspector"
    style:width="{width}px"
    data-testid="inspector"
    aria-label="Inspector"
  >
    <header class="head">
      <span class="title">Inspector</span>
      <IconButton
        variant="ghost"
        ariaLabel="Hide inspector"
        title="Hide inspector (Cmd/Ctrl+\\)"
        testId="inspector-collapse"
        onclick={() => (collapsed = true)}
      >›</IconButton>
    </header>
    <div class="body" data-testid="inspector-body">
      {#if !info}
        <p class="empty">Select a track to see details.</p>
      {:else}
        <div class="row identity">
          <span
            class="stripe-lg"
            data-testid="inspector-stripe"
            style:background={info.color}
          ></span>
          <input
            class="name-input"
            data-testid="inspector-name"
            bind:value={nameDraft}
            onblur={commitName}
            onkeydown={onNameKey}
            aria-label="Track name"
          />
        </div>

        <div class="row">
          <span class="lbl">Kind</span>
          <span class="val mono" data-testid="inspector-kind">{info.kind}</span>
        </div>

        {#if info.pluginId}
          <div class="row">
            <span class="lbl">Plugin</span>
            <span class="val mono" data-testid="inspector-plugin">
              {info.pluginId.replace(/^builtin:/, '')}
            </span>
          </div>
        {/if}

        <div class="row">
          <span class="lbl">Inserts</span>
          <span class="val mono" data-testid="inspector-insert-count">{info.insertCount}</span>
        </div>

        <div class="row">
          <span class="lbl">Sends</span>
          <span class="val mono" data-testid="inspector-send-count">{info.sendCount}</span>
        </div>

        <div class="row col">
          <span class="lbl">Color</span>
          <div class="palette" data-testid="inspector-palette">
            {#each TRACK_PALETTE as c (c)}
              <button
                type="button"
                class="swatch"
                class:on={info.color.toLowerCase() === c.toLowerCase()}
                style:background={c}
                aria-label="Set track color {c}"
                data-testid="inspector-swatch-{c}"
                onclick={() => pickColor(c)}
              ></button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .inspector {
    background: var(--bg-2);
    border-left: 1px solid var(--line-1);
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .inspector--collapsed {
    width: 24px;
    align-items: center;
    justify-content: flex-start;
    padding-top: var(--sp-3);
  }
  .head {
    height: 32px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-3);
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
  }
  .head .title {
    font-family: var(--font-mono);
    font-size: var(--text-11);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .body {
    flex: 1;
    overflow: auto;
    padding: var(--sp-4);
    color: var(--fg-1);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .empty {
    margin: 0;
    color: var(--fg-3);
    font-size: var(--text-11);
    line-height: 1.6;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    min-height: 22px;
  }
  .row.col {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
  }
  .row.identity { gap: var(--sp-3); }
  .lbl {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .val {
    color: var(--fg-0);
    font-size: var(--text-11);
  }
  .val.mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .stripe-lg {
    width: 6px;
    height: 22px;
    border-radius: var(--r-sm);
    flex-shrink: 0;
  }
  .name-input {
    flex: 1;
    background: var(--bg-0);
    color: var(--fg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    font-family: var(--font-sans);
    font-size: var(--text-12);
    padding: 2px 6px;
    height: 24px;
    min-width: 0;
  }
  .name-input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .palette {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: var(--sp-2);
  }
  .swatch {
    height: 22px;
    border-radius: var(--r-sm);
    border: 1px solid rgba(255, 255, 255, 0.08);
    cursor: pointer;
    padding: 0;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }
  .swatch:hover { filter: brightness(1.15); }
  .swatch.on {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
