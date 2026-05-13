<script lang="ts">
  /**
   * Phase 8 M5/M7 — third-party plugin picker. Modal dialog with
   * two tabs (Installed grid + Browse) matching the P9 design.
   * Browse fetches a curated registry of manifest URLs and renders
   * each as an installable card (M7); paste-your-own-URL still
   * works at the bottom (M5).
   *
   * The picker is purely UI; install + add-to-track are delegated
   * to callbacks the parent owns so the picker doesn't have to know
   * about Y.Doc, loader, or worklet state.
   */
  import { onMount } from 'svelte';
  import { parseManifestJson, type PluginManifest } from './plugin-manifest';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import SegmentedControl from './ui/SegmentedControl.svelte';

  /// Default curated registry — fetched the first time the Browse
  /// tab is opened. Users can paste their own URL in the input
  /// below to redirect to another registry.
  const DEFAULT_REGISTRY_URL = '/example-plugins/registry.json';

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

  /// Phase-8 M7 — fetched registry. Each entry carries the manifest
  /// URL we'll install from + the manifest itself (so cards show
  /// name/version/license without a second click).
  interface RegistryEntry {
    manifestUrl: string;
    manifest: PluginManifest;
  }
  let registryEntries = $state<RegistryEntry[]>([]);
  let registryLoading = $state(false);
  let registryError = $state<string | undefined>(undefined);
  let registryLoaded = false;

  async function loadRegistry(force = false) {
    if ((registryLoaded && !force) || registryLoading) return;
    registryLoading = true;
    registryError = undefined;
    try {
      const resp = await fetch(DEFAULT_REGISTRY_URL);
      if (!resp.ok) throw new Error(`registry fetch failed: ${resp.status}`);
      const body = (await resp.json()) as { plugins?: unknown };
      const urls = Array.isArray(body.plugins) ? body.plugins.filter((u): u is string => typeof u === 'string') : [];
      const base = new URL(DEFAULT_REGISTRY_URL, window.location.href);
      const fetched = await Promise.all(
        urls.map(async (rel) => {
          const manifestUrl = new URL(rel, base).toString();
          try {
            const mResp = await fetch(manifestUrl);
            if (!mResp.ok) throw new Error(`fetch ${mResp.status}`);
            const parsed = parseManifestJson(await mResp.text());
            if (!parsed.ok) throw new Error(parsed.issues[0]?.message ?? 'invalid manifest');
            return { manifestUrl, manifest: parsed.manifest } as RegistryEntry;
          } catch (err) {
            // Surface the bad entry so it's visible in the UI but
            // don't take down the whole registry.
            return {
              manifestUrl,
              manifest: {
                id: manifestUrl,
                name: manifestUrl.split('/').pop() ?? manifestUrl,
                version: '?',
                kind: 'effect',
                wasm: '',
                wasmIntegrity: '',
                params: [],
              } as PluginManifest,
              _error: (err as Error).message,
            } as RegistryEntry & { _error: string };
          }
        }),
      );
      registryEntries = fetched;
      registryLoaded = true;
    } catch (err) {
      registryError = (err as Error).message;
    } finally {
      registryLoading = false;
    }
  }

  // Lazy-load the registry when the Browse tab is opened for the
  // first time per dialog session.
  $effect(() => {
    if (tab === 'browse' && !registryLoaded && !registryLoading) {
      void loadRegistry();
    }
  });

  /// Has this registry entry already been installed?
  function isInstalled(entry: RegistryEntry): boolean {
    return installed.some((p) => p.manifest.id === entry.manifest.id);
  }

  async function installFromRegistry(entry: RegistryEntry) {
    if (installing) return;
    installing = true;
    installError = undefined;
    try {
      const err = await onInstall(entry.manifestUrl);
      if (err) {
        installError = `${entry.manifest.name}: ${err}`;
      } else {
        tab = 'installed';
      }
    } finally {
      installing = false;
    }
  }

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
      <section class="registry-section" data-testid="plugin-picker-registry">
        <header class="section-head">
          <h3 class="section-title">Registry</h3>
          <IconButton
            variant="ghost"
            ariaLabel="Refresh registry"
            testId="plugin-registry-refresh"
            title="Refresh"
            onclick={() => void loadRegistry(true)}
          >↻</IconButton>
        </header>

        {#if registryLoading}
          <p class="hint" data-testid="plugin-registry-loading">Loading registry…</p>
        {:else if registryError}
          <p class="error" data-testid="plugin-registry-error">
            Couldn't load registry: {registryError}
          </p>
        {:else if registryEntries.length === 0}
          <p class="hint" data-testid="plugin-registry-empty">
            The curated registry is empty. Paste a manifest URL below to install your own.
          </p>
        {:else}
          <div class="grid">
            {#each registryEntries as entry (entry.manifestUrl)}
              <article class="card" data-testid="registry-card-{entry.manifest.id}">
                <header class="card-head">
                  <span class="card-name">{entry.manifest.name}</span>
                  <span class="kind">{entry.manifest.kind}</span>
                </header>
                <p class="meta">
                  <span class="mono">{entry.manifest.id}</span>
                  <span class="dot">·</span>
                  <span class="mono">v{entry.manifest.version}</span>
                  {#if entry.manifest.license}
                    <span class="dot">·</span>
                    <span>{entry.manifest.license}</span>
                  {/if}
                </p>
                <p class="meta dim">{paramSummary(entry.manifest)}</p>
                <footer class="card-foot">
                  {#if isInstalled(entry)}
                    <span
                      class="installed-badge"
                      data-testid="registry-installed-{entry.manifest.id}"
                    >✓ Installed</span>
                  {:else}
                    <Button
                      variant="primary"
                      disabled={installing}
                      testId="registry-install-{entry.manifest.id}"
                      onclick={() => void installFromRegistry(entry)}
                    >Install</Button>
                  {/if}
                </footer>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section class="custom-install">
        <h3 class="section-title">Install from URL</h3>
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
      </section>
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

  .registry-section,
  .custom-install {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .custom-install {
    margin-top: var(--sp-5);
    padding-top: var(--sp-4);
    border-top: 1px solid var(--line-0);
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .section-title {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .installed-badge {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    color: var(--meter-ok);
    letter-spacing: 0.04em;
    padding: 4px 8px;
    border: 1px solid var(--meter-ok);
    border-radius: var(--r-sm);
  }

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
