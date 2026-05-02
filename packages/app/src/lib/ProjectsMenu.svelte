<script lang="ts">
  import { onMount } from 'svelte';
  import {
    createProjectInfo,
    deleteProjectStorage,
    loadRegistry,
    removeProjectFromRegistry,
    renameProjectInRegistry,
    setLastOpenedProject,
    type ProjectInfo,
    type Registry,
  } from './project-registry';

  const {
    activeProjectId,
    onSwitch,
  }: {
    activeProjectId: string | null;
    onSwitch: (id: string) => void;
  } = $props();

  let open = $state(false);
  let registry = $state<Registry>({ projects: [], lastOpenedId: null });
  let editingId = $state<string | null>(null);
  let editingName = $state('');

  function refresh() {
    registry = loadRegistry();
  }

  onMount(() => {
    refresh();
    // Cross-window sync via the storage event.
    const onStorage = () => refresh();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });

  const sorted = $derived.by(() =>
    [...registry.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
  );

  const activeProject = $derived(
    registry.projects.find((p) => p.id === activeProjectId) ?? null,
  );

  function toggle() {
    open = !open;
    if (open) refresh();
  }

  function handleNew() {
    const name = window.prompt('Project name:', 'Untitled');
    if (name == null) return; // cancel
    const info = createProjectInfo(name);
    refresh();
    onSwitch(info.id);
    open = false;
  }

  function handleSwitch(p: ProjectInfo) {
    if (p.id === activeProjectId) {
      open = false;
      return;
    }
    setLastOpenedProject(p.id);
    onSwitch(p.id);
    refresh();
    open = false;
  }

  function handleStartRename(p: ProjectInfo) {
    editingId = p.id;
    editingName = p.name;
  }

  function handleConfirmRename() {
    if (editingId == null) return;
    renameProjectInRegistry(editingId, editingName);
    editingId = null;
    editingName = '';
    refresh();
  }

  function handleCancelRename() {
    editingId = null;
    editingName = '';
  }

  async function handleDelete(p: ProjectInfo) {
    if (registry.projects.length <= 1) {
      window.alert('Cannot delete the last remaining project.');
      return;
    }
    const ok = window.confirm(`Delete "${p.name}"? This wipes its IndexedDB store.`);
    if (!ok) return;
    const docName = removeProjectFromRegistry(p.id);
    refresh();
    if (docName) {
      await deleteProjectStorage(docName);
    }
    if (p.id === activeProjectId) {
      const next = registry.lastOpenedId ?? registry.projects[0]?.id;
      if (next) onSwitch(next);
    }
  }
</script>

<div class="wrap">
  <button class="trigger" data-testid="projects-menu" onclick={toggle} aria-expanded={open}>
    {activeProject?.name ?? 'Project'} ▾
  </button>
  {#if open}
    <div class="menu" data-testid="projects-menu-list">
      <button class="new" data-testid="projects-new" onclick={handleNew}>+ New project…</button>
      <ol>
        {#each sorted as p (p.id)}
          <li class="row" class:active={p.id === activeProjectId}>
            {#if editingId === p.id}
              <input
                class="rename"
                data-testid={`projects-rename-${p.id}`}
                bind:value={editingName}
                onkeydown={(e) => {
                  if (e.key === 'Enter') handleConfirmRename();
                  else if (e.key === 'Escape') handleCancelRename();
                }}
              />
              <button onclick={handleConfirmRename}>OK</button>
              <button onclick={handleCancelRename}>Cancel</button>
            {:else}
              <button
                class="open"
                data-testid={`projects-open-${p.id}`}
                onclick={() => handleSwitch(p)}
              >{p.name}{p.id === activeProjectId ? ' • active' : ''}</button>
              <button
                class="rn"
                data-testid={`projects-rename-btn-${p.id}`}
                onclick={() => handleStartRename(p)}
                title="Rename"
              >✎</button>
              <button
                class="del"
                data-testid={`projects-delete-${p.id}`}
                onclick={() => handleDelete(p)}
                aria-label={`Delete ${p.name}`}
                title="Delete"
              >×</button>
            {/if}
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  .trigger {
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 10px;
    font: 11px system-ui, sans-serif;
    cursor: pointer;
    min-width: 120px;
    text-align: left;
  }
  .trigger:hover {
    background: #232323;
  }
  .menu {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    background: #131313;
    border: 1px solid #2a2a2a;
    color: #ccc;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    min-width: 240px;
    padding: 4px;
    z-index: 10;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .new {
    display: block;
    width: 100%;
    background: #1a1a1a;
    color: #ddd;
    border: 1px dashed #2a2a2a;
    padding: 4px 8px;
    font: inherit;
    cursor: pointer;
    margin-bottom: 4px;
    text-align: left;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .row.active .open {
    color: #ff8c00;
  }
  .open {
    flex: 1;
    background: transparent;
    color: #ddd;
    border: 1px solid transparent;
    padding: 3px 6px;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .open:hover {
    background: #1f1f1f;
    border-color: #2a2a2a;
  }
  .rn,
  .del {
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #888;
    padding: 2px 6px;
    cursor: pointer;
    font: inherit;
  }
  .del:hover {
    color: #f55;
  }
  .rename {
    flex: 1;
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 2px 4px;
    font: inherit;
  }
</style>
