<script lang="ts">
  import { onMount } from 'svelte';
  import {
    activeProjects,
    archiveProject,
    archivedProjects,
    createProjectInfo,
    emptyTrash,
    loadRegistry,
    purgeProject,
    renameProjectInRegistry,
    restoreProject,
    setLastOpenedProject,
    trashSizeBytes,
    TRASH_WARN_BYTES,
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
  let trashOpen = $state(false);
  let registry = $state<Registry>({ projects: [], lastOpenedId: null });
  let editingId = $state<string | null>(null);
  let editingName = $state('');

  function refresh() {
    registry = loadRegistry();
  }

  onMount(() => {
    refresh();
    const onStorage = () => refresh();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });

  const active = $derived.by(() =>
    [...activeProjects(registry)].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
  );
  const archived = $derived.by(() =>
    [...archivedProjects(registry)].sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  );
  const trashBytes = $derived(trashSizeBytes(registry));
  const trashOverLimit = $derived(trashBytes > TRASH_WARN_BYTES);

  const activeProject = $derived(
    registry.projects.find((p) => p.id === activeProjectId) ?? null,
  );

  function toggle() {
    open = !open;
    if (open) refresh();
  }

  function handleNew() {
    const name = window.prompt('Project name:', 'Untitled');
    if (name == null) return;
    const info = createProjectInfo(name);
    refresh();
    onSwitch(info.id);
    open = false;
  }

  function handleNewDemo() {
    const info = createProjectInfo('Demo Song', { seed: 'demo' });
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

  async function handleArchive(p: ProjectInfo) {
    if (active.length <= 1) {
      window.alert('Cannot archive the last remaining project.');
      return;
    }
    const ok = window.confirm(
      `Move "${p.name}" to trash? You can restore it from the trash list.`,
    );
    if (!ok) return;
    const wasActive = p.id === activeProjectId;
    await archiveProject(p.id);
    refresh();
    open = false;
    if (wasActive) {
      const next = registry.lastOpenedId ?? active[0]?.id;
      if (next) onSwitch(next);
    }
  }

  function handleRestore(p: ProjectInfo) {
    restoreProject(p.id);
    refresh();
  }

  async function handlePermanentDelete(p: ProjectInfo) {
    const ok = window.confirm(
      `Permanently delete "${p.name}"? This wipes its IndexedDB store and cannot be undone.`,
    );
    if (!ok) return;
    await purgeProject(p.id);
    refresh();
  }

  async function handleEmptyTrash() {
    if (archived.length === 0) return;
    const ok = window.confirm(
      `Permanently delete ${archived.length} archived project${archived.length === 1 ? '' : 's'}? This cannot be undone.`,
    );
    if (!ok) return;
    await emptyTrash();
    refresh();
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="wrap">
  <button class="trigger" data-testid="projects-menu" onclick={toggle} aria-expanded={open}>
    {activeProject?.name ?? 'Project'} ▾
  </button>
  {#if open}
    <div class="menu" data-testid="projects-menu-list">
      <button class="new" data-testid="projects-new" onclick={handleNew}>+ New project…</button>
      <button class="new demo" data-testid="projects-new-demo" onclick={handleNewDemo}>★ Demo Song</button>
      <ol>
        {#each active as p (p.id)}
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
                data-testid={`projects-archive-${p.id}`}
                onclick={() => void handleArchive(p)}
                aria-label={`Move ${p.name} to trash`}
                title="Move to trash"
              >×</button>
            {/if}
          </li>
        {/each}
      </ol>

      <div class="trash" data-testid="projects-trash-section">
        <button
          class="trash-toggle"
          data-testid="projects-trash-toggle"
          onclick={() => (trashOpen = !trashOpen)}
          aria-expanded={trashOpen}
        >
          {trashOpen ? '▾' : '▸'} Trash ({archived.length}{archived.length > 0
            ? `, ${fmtBytes(trashBytes)}`
            : ''})
        </button>
        {#if trashOpen}
          {#if trashOverLimit}
            <div class="warn" data-testid="projects-trash-warn">
              Trash exceeds {fmtBytes(TRASH_WARN_BYTES)}. Empty trash to reclaim space.
            </div>
          {/if}
          {#if archived.length === 0}
            <div class="empty">Trash is empty.</div>
          {:else}
            <ol class="trash-list">
              {#each archived as p (p.id)}
                <li class="row trashed" data-testid={`projects-trash-row-${p.id}`}>
                  <span class="open trashed-name">{p.name}</span>
                  <span class="size">{fmtBytes(p.archivedSize ?? 0)}</span>
                  <button
                    class="rn"
                    data-testid={`projects-restore-${p.id}`}
                    onclick={() => handleRestore(p)}
                    title="Restore"
                  >↺</button>
                  <button
                    class="del"
                    data-testid={`projects-purge-${p.id}`}
                    onclick={() => void handlePermanentDelete(p)}
                    title="Delete permanently"
                  >🗑</button>
                </li>
              {/each}
            </ol>
            <button
              class="empty-btn"
              data-testid="projects-empty-trash"
              onclick={() => void handleEmptyTrash()}
            >Empty trash</button>
          {/if}
        {/if}
      </div>
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
    min-width: 280px;
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
  .new.demo {
    color: #ff8c00;
    border-color: #5a3f10;
  }
  .new.demo:hover {
    background: #2a1f0a;
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
  .trash {
    margin-top: 6px;
    border-top: 1px solid #2a2a2a;
    padding-top: 6px;
  }
  .trash-toggle {
    background: transparent;
    color: #aaa;
    border: 1px solid #2a2a2a;
    padding: 3px 6px;
    width: 100%;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .trash-toggle:hover {
    background: #1f1f1f;
  }
  .trash-list {
    margin-top: 4px;
  }
  .trashed-name {
    color: #999;
    font-style: italic;
  }
  .size {
    color: #666;
    font: 10px ui-monospace, monospace;
    margin-right: 4px;
  }
  .warn {
    background: #2a1f0a;
    color: #ffb84a;
    border: 1px solid #5a3f10;
    padding: 4px 6px;
    margin-top: 4px;
    font-size: 10px;
  }
  .empty {
    color: #666;
    padding: 4px;
    font-style: italic;
    font-size: 10px;
  }
  .empty-btn {
    margin-top: 4px;
    background: #2a0e0e;
    color: #ff8585;
    border: 1px solid #5a1010;
    padding: 3px 8px;
    font: inherit;
    cursor: pointer;
  }
</style>
