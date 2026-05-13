<script lang="ts">
  /**
   * Phase 8 M5 — third-party plugin picker. Modal dialog with two
   * tabs (Installed grid + Browse / Install from URL) matching the
   * P9 design. The picker is purely UI; install + add-to-track are
   * delegated to callbacks the parent owns so the picker doesn't
   * have to know about Y.Doc, loader, or worklet state.
   */
  import { onMount } from 'svelte';
  import type { PluginManifest } from './plugin-manifest';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import SegmentedControl from './ui/SegmentedControl.svelte';

  export interface InstalledPlugin {
    manifest: PluginManifest;
    /** Worklet-assigned handle. 0 means "not registered" — either
     *  the plugin failed to load on boot, or registration is still
     *  in flight. */
    handle: number;
    /** Set when boot-time re-registration failed (fetch, integrity,
     *  manifest invalid). Surfaces as a red badge on the card. */
    loadError?: string;
  }

  let {
    open = $bindable(),
    installed,
    selectedTrackName,
    onInstall,
    onAddToTrack,
  }: {
    open: boolean;
    installed: InstalledPlugin[];
    selectedTrackName: string;
    /** Fetch + validate + load the manifest at `url`. Returns an
     *  error message on failure, undefined on success. The parent
     *  pushes the loaded plugin into `installed` on success. */
    onInstall: (url: string) => Promise<string | undefined>;
    onAddToTrack: (plugin: InstalledPlugin) => void;
  } = $props();

  type Tab = 'installed' | 'browse';
  let tab = $state<Tab>('installed');
  let urlInput = $state('');
  let installing = $state(false);
  let installError = $state<string | undefined>(undefined);

  let dialogEl: HTMLDialogElement;

  // Bind `open` ↔ <dialog>.showModal() / close() so the parent can
  // open/close declaratively. Modal mode is what we want — it traps
  // focus + paints a backdrop the browser owns.
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  // <dialog> native close (ESC key, backdrop click handled by us)
  // dispatches `close` — propagate back into the bound state.
  function onDialogClose() {
    open = false;
    installError = undefined;
  }

  onMount(() => {
    dialogEl?.addEventListener('close', onDialogClose);
    return () => dialogEl?.removeEventListener('close', onDialogClose);
  });

  async function handleInstall() {
    const url = urlInput.trim();
    if (!url || installing) return;
    installing = true;
    installError = undefined;
    try {
      const err = await onInstall(url);
      if (err) {
        installError = err;
      } else {
        urlInput = '';
        tab = 'installed';
      }
    } finally {
      installing = false;
    }
  }

  function close() {
    open = false;
  }

  function paramSummary(m: PluginManifest): string {
    if (m.params.length === 0) return 'no params';
    return `${m.params.length} param${m.params.length === 1 ? '' : 's'}`;
  }
</script>

<dialog
  bind:this={dialogEl}
  class="picker"
  data-testid="plugin-picker"
  aria-labelledby="plugin-picker-title"
>
  <header>
    <h2 id="plugin-picker-title">Plugins</h2>
    <SegmentedControl
      bind:value={tab}
      ariaLabel="Plugin picker tabs"
      testId="plugin-picker-tabs"
      options={[
        { value: 'installed', label: `Installed (${installed.length})` },
        { value: 'browse', label: 'Browse / Install' },
      ]}
    />
    <IconButton
      variant="ghost"
      ariaLabel="Close picker"
      testId="plugin-picker-close"
      onclick={close}
    >×</IconButton>
  </header>

  <div class="body">
    {#if tab === 'installed'}
      {#if installed.length === 0}
        <p class="empty" data-testid="plugin-picker-empty">
          No plugins installed yet. Open the <em>Browse / Install</em> tab and
          paste a plugin manifest URL.
        </p>
      {:else}
        <div class="grid" data-testid="plugin-picker-installed">
          {#each installed as p (p.manifest.id)}
            <article
              class="card"
              class:card--failed={!!p.loadError}
              data-testid="plugin-card-{p.manifest.id}"
            >
              <header class="card-head">
                <span class="card-name">{p.manifest.name}</span>
                {#if p.loadError}
                  <span class="failed" data-testid="plugin-card-failed-{p.manifest.id}">FAILED</span>
                {:else}
                  <span class="kind">{p.manifest.kind}</span>
                {/if}
              </header>
              <p class="meta">
                <span class="mono">{p.manifest.id}</span>
                <span class="dot">·</span>
                <span class="mono">v{p.manifest.version}</span>
                {#if p.manifest.license}
                  <span class="dot">·</span>
                  <span>{p.manifest.license}</span>
                {/if}
              </p>
              {#if p.loadError}
                <p class="error-inline" data-testid="plugin-card-error-{p.manifest.id}">
                  {p.loadError}
                </p>
              {:else}
                <p class="meta dim">{paramSummary(p.manifest)}</p>
              {/if}
              <footer class="card-foot">
                <Button
                  variant="primary"
                  disabled={!!p.loadError || p.handle === 0}
                  testId="plugin-add-{p.manifest.id}"
                  onclick={() => onAddToTrack(p)}
                >Add to {selectedTrackName}</Button>
              </footer>
            </article>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="install-form">
        <label class="lbl" for="manifest-url">Plugin manifest URL</label>
        <input
          id="manifest-url"
          type="url"
          placeholder="https://example.com/plugin.json"
          bind:value={urlInput}
          disabled={installing}
          onkeydown={(e) => { if (e.key === 'Enter') void handleInstall(); }}
          data-testid="plugin-url-input"
        />
        <Button
          variant="primary"
          disabled={installing || urlInput.trim().length === 0}
          testId="plugin-install"
          onclick={() => void handleInstall()}
        >{installing ? 'Installing…' : 'Install'}</Button>
      </div>
      {#if installError}
        <p class="error" data-testid="plugin-install-error">{installError}</p>
      {/if}
      <p class="hint">
        The picker fetches the manifest JSON, verifies its SHA-256
        integrity hash against the linked WASM, and registers the
        plugin with the audio worklet. Plugins are sandboxed — they
        only see audio I/O, never the DOM or network.
      </p>
    {/if}
  </div>
</dialog>

<style>
  .picker {
    /* Override default <dialog> chrome with the P0 tokens. */
    background: var(--bg-1);
    color: var(--fg-0);
    border: 1px solid var(--line-2);
    border-radius: var(--r-md);
    padding: 0;
    min-width: 560px;
    max-width: 720px;
    max-height: 80vh;
    overflow: hidden;
    box-shadow: var(--shadow-pop);
  }
  .picker::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: var(--sp-4);
    border-bottom: 1px solid var(--line-1);
    background: var(--bg-2);
  }
  h2 {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-14);
    color: var(--fg-0);
    flex: 1;
  }

  .body {
    padding: var(--sp-4);
    overflow-y: auto;
    max-height: calc(80vh - 64px);
  }

  .empty {
    color: var(--fg-2);
    font-size: var(--text-12);
    line-height: 1.5;
  }
  .empty em {
    color: var(--fg-0);
    font-style: normal;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--sp-3);
  }
  .card {
    background: var(--bg-2);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-2);
  }
  .card-name {
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: var(--text-12);
    color: var(--fg-0);
  }
  .kind {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .failed {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--accent-fg);
    background: var(--accent);
    padding: 2px 6px;
    border-radius: var(--r-sm);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .card--failed {
    border-color: var(--accent-lo);
    background: rgba(226, 52, 45, 0.06);
  }
  .error-inline {
    margin: 0;
    color: var(--accent-hi);
    font-size: var(--text-10);
    font-family: var(--font-mono);
    line-height: 1.5;
    word-break: break-word;
  }
  .meta {
    margin: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-2);
    font-size: var(--text-11);
    color: var(--fg-1);
  }
  .meta.dim { color: var(--fg-2); }
  .meta .mono { font-family: var(--font-mono); }
  .meta .dot { color: var(--fg-3); }
  .card-foot { margin-top: auto; }

  .install-form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--sp-3);
    align-items: end;
  }
  .install-form .lbl {
    grid-column: 1 / -1;
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .install-form input {
    background: var(--bg-0);
    color: var(--fg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: 6px 10px;
    font-family: var(--font-mono);
    font-size: var(--text-12);
    height: 30px;
  }
  .install-form input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .error {
    margin-top: var(--sp-3);
    padding: var(--sp-3);
    background: rgba(226, 52, 45, 0.1);
    border: 1px solid var(--accent-lo);
    border-radius: var(--r-sm);
    color: var(--accent-hi);
    font-size: var(--text-11);
    line-height: 1.5;
  }
  .hint {
    margin-top: var(--sp-4);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--line-0);
    color: var(--fg-3);
    font-size: var(--text-11);
    line-height: 1.6;
  }
</style>
