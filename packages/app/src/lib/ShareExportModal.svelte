<script lang="ts">
  import { getTrackName, type Project } from './project';
  import type { CollabSession } from './collab-session.svelte';
  import { Button } from './ui';
  import {
    buildBundle,
    estimateBundle,
    triggerDownload,
    formatBytes,
    BUNDLE_EXT,
  } from './bundle';
  import {
    renderProjectToWav,
    renderEndTick,
    ticksToSeconds,
    type RenderRange,
  } from './render';
  import type { BitDepth } from './wav';

  /**
   * Phase-10 M7 — Share & Export modal (P13).
   *
   * One modal, three tabs:
   *   - Share live   (M7a) — wraps the Phase-9 collab session: room
   *                  URL + copy, collaborator list, start / end.
   *   - Export bundle (M7b) — zip of project + assets.
   *   - Render audio  (M7d) — offline render to WAV.
   *
   * M7a ships the shell + Share-live tab; the Export / Render tab
   * buttons render disabled until their milestones land.
   */
  type ShareTab = 'share' | 'export' | 'render';

  const {
    open,
    initialTab = 'share',
    project,
    session,
    selectedTrackIdx,
    onStartSession,
    onEndSession,
    onClose,
  }: {
    open: boolean;
    initialTab?: ShareTab;
    project: Project;
    session: CollabSession;
    selectedTrackIdx: number;
    onStartSession: () => void;
    onEndSession: () => void;
    onClose: () => void;
  } = $props();

  const TABS: { id: ShareTab; num: string; label: string; ready: boolean }[] = [
    { id: 'share', num: '01', label: 'Share live', ready: true },
    { id: 'export', num: '02', label: 'Export bundle', ready: true },
    { id: 'render', num: '03', label: 'Render audio', ready: true },
  ];

  let tab = $state<ShareTab>(initialTab);
  // Re-seed the active tab each time the modal is (re)opened so the
  // ⤴ button can deep-link to a specific tab.
  $effect(() => {
    if (open) tab = initialTab;
  });

  const inSession = $derived(session.activeRoomId != null);
  const peers = $derived(session.collab?.peers ?? []);

  /// Full shareable URL for the active room, mirroring how
  /// `session.share` builds it (`?room=<id>` on the current href).
  const roomUrl = $derived.by(() => {
    if (!session.activeRoomId) return null;
    const u = new URL(window.location.href);
    u.searchParams.set('room', session.activeRoomId);
    return u.toString();
  });

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  async function copyLink() {
    if (!roomUrl) return;
    try {
      await navigator.clipboard.writeText(roomUrl);
    } catch {
      /* clipboard may be blocked — the URL is still visible */
    }
    copied = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied = false; }, 1500);
  }

  function peerTrackLabel(idx: number | undefined): string {
    if (idx == null) return 'viewing';
    return getTrackName(project, idx) ?? `track ${idx + 1}`;
  }

  // ── Export bundle tab (M7b) ──────────────────────────────────────
  let exportName = $state('project');
  let includeAudio = $state(true);
  let estimate = $state<{ bytes: number; assetCount: number } | null>(null);
  let exporting = $state(false);

  // Recompute the size estimate whenever the export tab is visible and
  // its inputs change. Guarded so a slow OPFS read can't clobber a
  // newer estimate.
  $effect(() => {
    if (!open || tab !== 'export') return;
    const wantAudio = includeAudio;
    let stale = false;
    estimate = null;
    void estimateBundle(project, wantAudio).then((e) => {
      if (!stale) estimate = e;
    });
    return () => { stale = true; };
  });

  function safeName(): string {
    return (exportName.trim() || 'project').replace(/[^\w.-]+/g, '_');
  }

  async function doExport() {
    if (exporting) return;
    exporting = true;
    try {
      const name = safeName();
      const { zip } = await buildBundle(project, name, includeAudio);
      triggerDownload(name + BUNDLE_EXT, zip);
    } finally {
      exporting = false;
    }
  }

  // ── Render audio tab (M7d) ───────────────────────────────────────
  const SAMPLE_RATES = [
    { v: '44100', label: '44.1 kHz · CD' },
    { v: '48000', label: '48.0 kHz · session' },
    { v: '88200', label: '88.2 kHz · 2×' },
    { v: '96000', label: '96.0 kHz · HD' },
    { v: '192000', label: '192 kHz · max' },
  ];
  const BIT_DEPTHS = [
    { v: '16', label: '16-bit · int' },
    { v: '24', label: '24-bit · int' },
    { v: '32', label: '32-bit · float' },
  ];
  const TAIL_SECONDS = 2;

  let renderFormat = $state<'WAV' | 'FLAC' | 'MP3'>('WAV');
  let renderSampleRate = $state('48000');
  let renderBitDepth = $state('24');
  let renderRange = $state<RenderRange>('project');
  let rendering = $state(false);

  const renderTicks = $derived(renderEndTick(project, renderRange));
  const renderSeconds = $derived(ticksToSeconds(project, renderTicks) + TAIL_SECONDS);
  const renderSizeBytes = $derived(
    Math.round(renderSeconds * Number(renderSampleRate) * 2 * (Number(renderBitDepth) / 8)),
  );

  function fmtDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  }

  async function doRender() {
    if (rendering) return;
    rendering = true;
    try {
      const { wav } = await renderProjectToWav(project, {
        sampleRate: Number(renderSampleRate),
        bitDepth: Number(renderBitDepth) as BitDepth,
        range: renderRange,
        tailSeconds: TAIL_SECONDS,
      });
      triggerDownload(`${safeName()}.wav`, wav, 'audio/wav');
    } finally {
      rendering = false;
    }
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  $effect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const activeLabel = $derived(TABS.find((t) => t.id === tab)?.label ?? '');
</script>

{#if open}
  <div
    class="backdrop"
    data-testid="share-export-backdrop"
    onclick={onBackdropClick}
    role="dialog"
    aria-modal="true"
    aria-label="Share and export"
  >
    <aside class="modal" data-testid="share-export-modal">
      <header class="head">
        <div class="title">
          <span class="nm">Share &amp; Export</span>
          <span class="crumb">/ {activeLabel}</span>
        </div>
        <button
          class="x"
          data-testid="share-export-close"
          onclick={onClose}
          aria-label="Close"
        >×</button>
      </header>

      <nav class="tabs" aria-label="Share and export tabs">
        {#each TABS as t (t.id)}
          <button
            class="tab"
            class:on={tab === t.id}
            disabled={!t.ready}
            title={t.ready ? undefined : 'Coming soon'}
            data-testid={`share-tab-${t.id}`}
            aria-pressed={tab === t.id}
            onclick={() => { if (t.ready) tab = t.id; }}
          ><span class="num">§ {t.num}</span>{t.label}</button>
        {/each}
      </nav>

      <section class="body" data-testid="share-export-body">
        {#if tab === 'share'}
          {#if inSession}
            <div class="field">
              <div class="lbl">
                ROOM URL
                <span class="hint">share with anyone — opens directly in their browser</span>
              </div>
              <div class="url-bar">
                <span class="url mono" data-testid="share-room-url">{roomUrl}</span>
                <button
                  class="copy"
                  class:copied
                  data-testid="share-copy-link"
                  onclick={copyLink}
                >{copied ? '✓ Copied' : '⧉ Copy'}</button>
              </div>
            </div>

            <div class="perm">
              <span class="pill">Edit</span>
              <span class="txt">
                <b>Anyone with the link can edit.</b>
                Cursors, selections and recordings sync live.
              </span>
            </div>

            <div class="field">
              <div class="collab-head">
                <span class="ttl">Connected · {peers.length + 1}</span>
                <span class="status mono">{session.syncStatus}</span>
              </div>
              <div class="collab-list" data-testid="share-collab-list">
                <div class="collab-row you" data-testid="share-collab-self">
                  <span class="av" style:background-color={session.user.color}>
                    {session.user.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div class="who">
                    <div class="who-name">{session.user.name}<span class="self">YOU</span></div>
                    <div class="where">{peerTrackLabel(selectedTrackIdx)}</div>
                  </div>
                  <span class="role">OWNER</span>
                </div>
                {#each peers as p (p.id)}
                  <div class="collab-row" data-testid={`share-collab-peer-${p.id}`}>
                    <span class="av" style:background-color={p.state.user?.color ?? 'var(--fg-3)'}>
                      {(p.state.user?.name ?? '?').slice(0, 1).toUpperCase()}
                    </span>
                    <div class="who">
                      <div class="who-name">{p.state.user?.name ?? 'peer'}</div>
                      <div class="where">{peerTrackLabel(p.state.selectedTrackIdx)}</div>
                    </div>
                    <span class="role">EDITOR</span>
                  </div>
                {/each}
              </div>
            </div>
          {:else}
            <div class="empty" data-testid="share-not-in-session">
              Not in a live session. Start one to get a shareable link —
              anyone who opens it joins the same project with live cursors
              and edits.
            </div>
          {/if}
        {:else if tab === 'export'}
          <div class="field">
            <div class="lbl">
              FILENAME
              <span class="hint">project + assets bundled into one archive</span>
            </div>
            <div class="input-row">
              <input
                class="text-input mono"
                data-testid="share-export-filename"
                value={exportName}
                oninput={(e) => { exportName = (e.currentTarget as HTMLInputElement).value; }}
              />
              <span class="ext mono">{BUNDLE_EXT}</span>
            </div>
          </div>

          <div class="field">
            <div class="lbl">CONTENTS</div>
            <button
              type="button"
              class="toggle"
              class:on={includeAudio}
              data-testid="share-export-include-audio"
              aria-pressed={includeAudio}
              onclick={() => { includeAudio = !includeAudio; }}
            >
              <span class="sw"></span>
              <span class="toggle-lbl">
                Include audio assets
                <span class="hint">source clips stored in OPFS</span>
              </span>
            </button>
          </div>

          <div class="readout">
            <div class="col">
              <span class="k">Estimated size</span>
              <span class="v mono" data-testid="share-export-estimate">
                {estimate ? formatBytes(estimate.bytes) : '…'}
              </span>
            </div>
            <div class="col">
              <span class="k">Audio clips</span>
              <span class="v mono">{includeAudio ? (estimate?.assetCount ?? '…') : 0}</span>
            </div>
            <div class="col">
              <span class="k">Compression</span>
              <span class="v mono">deflate</span>
            </div>
          </div>
        {:else if tab === 'render'}
          <div class="field">
            <div class="lbl">FORMAT</div>
            <div class="chips">
              {#each (['WAV', 'FLAC', 'MP3'] as const) as f (f)}
                <button
                  type="button"
                  class="chip"
                  class:on={renderFormat === f}
                  disabled={f !== 'WAV'}
                  title={f === 'WAV' ? undefined : 'Coming soon'}
                  data-testid={`share-render-format-${f}`}
                  onclick={() => { if (f === 'WAV') renderFormat = f; }}
                >
                  <span class="chip-nm">{f}</span>
                  <span class="chip-desc">
                    {f === 'WAV' ? 'lossless · uncompressed' : 'soon'}
                  </span>
                </button>
              {/each}
            </div>
          </div>

          <div class="grid2">
            <div class="field">
              <div class="lbl">SAMPLE RATE</div>
              <select class="select mono" data-testid="share-render-samplerate" bind:value={renderSampleRate}>
                {#each SAMPLE_RATES as sr (sr.v)}
                  <option value={sr.v}>{sr.label}</option>
                {/each}
              </select>
            </div>
            <div class="field">
              <div class="lbl">BIT DEPTH</div>
              <select class="select mono" data-testid="share-render-bitdepth" bind:value={renderBitDepth}>
                {#each BIT_DEPTHS as bd (bd.v)}
                  <option value={bd.v}>{bd.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="field">
            <div class="lbl">RENDER RANGE</div>
            <div class="seg-range">
              <button
                type="button"
                class:on={renderRange === 'loop'}
                data-testid="share-render-range-loop"
                onclick={() => { renderRange = 'loop'; }}
              >Loop region</button>
              <button
                type="button"
                class:on={renderRange === 'project'}
                data-testid="share-render-range-project"
                onclick={() => { renderRange = 'project'; }}
              >Entire project</button>
            </div>
          </div>

          <div class="bytes-block mono" data-testid="share-render-dryrun">
            <div>$ 8347 render --format=wav --sr={renderSampleRate} --bits={renderBitDepth} --range={renderRange}</div>
            <div>&gt; dry run: <span class="ok">ok</span> · expected
              <span class="hl" data-testid="share-render-estimate">{fmtDuration(renderSeconds)}</span>
              · output <span class="hl">{formatBytes(renderSizeBytes)}</span>
            </div>
            <div class="note">WASM-plugin inserts are not included in offline renders.</div>
          </div>
        {/if}
      </section>

      <footer class="foot">
        <div class="summary mono">
          {#if tab === 'share'}
            {#if inSession}
              <span class="k">SESSION</span>
              <span class="v">{session.activeRoomId}</span>
              · {peers.length + 1} connected
            {:else}
              <span class="k">LOCAL</span>
              <span class="v">no session</span>
            {/if}
          {:else if tab === 'export'}
            <span class="k">OUTPUT</span>
            <span class="v">{safeName()}{BUNDLE_EXT}</span>
            · {estimate ? formatBytes(estimate.bytes) : '…'}
          {:else if tab === 'render'}
            <span class="k">OUTPUT</span>
            <span class="v">{safeName()}.wav</span>
            · {fmtDuration(renderSeconds)}
          {/if}
        </div>
        <div class="actions">
          {#if tab === 'share'}
            {#if inSession}
              <Button variant="ghost" testId="share-end-session" onclick={onEndSession}>
                End session
              </Button>
              <Button variant="primary" testId="share-done" onclick={onClose}>
                ✓ Done
              </Button>
            {:else}
              <Button variant="ghost" testId="share-cancel" onclick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" testId="share-start-session" onclick={onStartSession}>
                ⤴ Start session
              </Button>
            {/if}
          {:else if tab === 'export'}
            <Button variant="ghost" testId="share-export-cancel" onclick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              testId="share-export-run"
              disabled={exporting}
              onclick={doExport}
            >⬇ {exporting ? 'Exporting…' : 'Export bundle'}</Button>
          {:else if tab === 'render'}
            <Button variant="ghost" testId="share-render-cancel" onclick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              testId="share-render-run"
              disabled={rendering}
              onclick={doRender}
            >● {rendering ? 'Rendering…' : 'Render'}</Button>
          {/if}
        </div>
      </footer>
    </aside>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9000;
  }
  .modal {
    width: min(620px, 94vw);
    max-height: 88vh;
    overflow-y: auto;
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-pop);
    color: var(--fg-1);
    font-family: var(--font-sans);
    font-size: var(--text-12);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-4) var(--sp-5);
    border-bottom: 1px solid var(--line-0);
  }
  .title { display: flex; align-items: baseline; gap: var(--sp-3); }
  .title .nm {
    font-weight: 600;
    color: var(--fg-0);
    letter-spacing: 0.02em;
  }
  .title .crumb { color: var(--fg-2); font-size: var(--text-11); }
  .x {
    appearance: none;
    background: transparent;
    border: 1px solid var(--line-1);
    color: var(--fg-2);
    width: 24px;
    height: 24px;
    line-height: 20px;
    border-radius: var(--r-sm);
    cursor: pointer;
    font-size: 15px;
    padding: 0;
  }
  .x:hover { color: var(--fg-0); border-color: var(--line-2); }

  .tabs {
    display: flex;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-5) 0;
    border-bottom: 1px solid var(--line-0);
  }
  .tab {
    appearance: none;
    background: transparent;
    color: var(--fg-2);
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
    padding: var(--sp-3) var(--sp-4);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: var(--text-12);
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .tab .num { font-family: var(--font-mono); font-size: var(--text-10); color: var(--fg-3); }
  .tab:hover:not(:disabled) { color: var(--fg-0); }
  .tab:disabled { opacity: 0.4; cursor: not-allowed; }
  .tab.on {
    background: var(--bg-1);
    color: var(--fg-0);
    border-color: var(--line-1);
    margin-bottom: -1px;
  }
  .tab.on .num { color: var(--accent); }

  .body { padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-5); min-height: 180px; }

  .field { display: flex; flex-direction: column; gap: var(--sp-3); }
  .lbl {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    letter-spacing: 0.08em;
    color: var(--fg-2);
    display: flex;
    gap: var(--sp-3);
    align-items: baseline;
  }
  .lbl .hint { letter-spacing: 0; text-transform: none; color: var(--fg-3); font-family: var(--font-sans); }

  .url-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    background: var(--bg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: var(--sp-3);
    box-shadow: var(--shadow-inset);
  }
  .url-bar .url {
    flex: 1;
    color: var(--fg-1);
    font-size: var(--text-11);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .copy {
    appearance: none;
    background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
    border: 1px solid var(--line-2);
    color: var(--fg-0);
    border-radius: var(--r-sm);
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
    font-size: var(--text-11);
    white-space: nowrap;
  }
  .copy:hover { filter: brightness(1.1); }
  .copy.copied { color: var(--meter-ok); border-color: var(--meter-ok); }

  .perm {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    background: var(--accent-tint);
    border: 1px solid var(--accent-lo);
    border-radius: var(--r-sm);
    padding: var(--sp-3) var(--sp-4);
  }
  .perm .pill {
    font-family: var(--font-mono);
    font-size: var(--text-10);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent-hi);
    border: 1px solid var(--accent-lo);
    border-radius: var(--r-sm);
    padding: 1px 6px;
  }
  .perm .txt { color: var(--fg-1); font-size: var(--text-11); }
  .perm .txt b { color: var(--fg-0); }

  .collab-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .collab-head .ttl { color: var(--fg-1); font-weight: 500; }
  .collab-head .status { color: var(--fg-2); font-size: var(--text-10); text-transform: uppercase; letter-spacing: 0.06em; }
  .collab-list { display: flex; flex-direction: column; gap: var(--sp-2); }
  .collab-row {
    display: grid;
    grid-template-columns: max-content 1fr max-content;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-2);
    border: 1px solid var(--line-0);
    border-radius: var(--r-sm);
  }
  .collab-row.you { border-color: var(--line-1); }
  .av {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #07070a;
    font-weight: 700;
    font-size: var(--text-11);
  }
  .who-name { color: var(--fg-0); display: flex; align-items: center; gap: var(--sp-2); }
  .who-name .self {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--fg-2);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: 0 3px;
  }
  .where { color: var(--fg-2); font-size: var(--text-10); }
  .role {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.06em;
    color: var(--fg-2);
  }

  .empty {
    color: var(--fg-2);
    font-style: italic;
    border: 1px dashed var(--line-1);
    border-radius: var(--r-sm);
    padding: var(--sp-5);
    text-align: center;
  }

  .input-row {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    background: var(--bg-0);
    box-shadow: var(--shadow-inset);
    overflow: hidden;
  }
  .text-input {
    flex: 1;
    appearance: none;
    background: transparent;
    border: none;
    color: var(--fg-0);
    padding: var(--sp-3);
    font-size: var(--text-12);
  }
  .text-input:focus { outline: none; }
  .input-row:focus-within { border-color: var(--accent); }
  .ext {
    display: flex;
    align-items: center;
    padding: 0 var(--sp-3);
    background: var(--bg-2);
    color: var(--fg-2);
    border-left: 1px solid var(--line-1);
    font-size: var(--text-11);
  }

  .toggle {
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-3);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .toggle .sw {
    width: 32px;
    height: 18px;
    border-radius: 9px;
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    position: relative;
    transition: background 0.12s;
    flex: none;
  }
  .toggle .sw::after {
    content: '';
    position: absolute;
    top: 1px;
    left: 1px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--fg-2);
    transition: transform 0.12s, background 0.12s;
  }
  .toggle.on .sw { background: var(--accent-tint); border-color: var(--accent-lo); }
  .toggle.on .sw::after { transform: translateX(14px); background: var(--accent-hi); }
  .toggle-lbl { color: var(--fg-1); display: flex; flex-direction: column; }
  .toggle-lbl .hint { color: var(--fg-3); font-size: var(--text-10); }

  .readout {
    display: flex;
    gap: var(--sp-6);
    padding: var(--sp-4);
    background: var(--bg-0);
    border: 1px solid var(--line-0);
    border-radius: var(--r-sm);
  }
  .readout .col { display: flex; flex-direction: column; gap: var(--sp-1); }
  .readout .k {
    font-size: var(--text-10);
    color: var(--fg-3);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .readout .v { color: var(--fg-0); font-size: var(--text-14); }

  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); }
  .select {
    appearance: none;
    background: var(--bg-0);
    color: var(--fg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: var(--sp-3);
    font-size: var(--text-11);
    box-shadow: var(--shadow-inset);
    width: 100%;
  }
  .select:focus { outline: none; border-color: var(--accent); }

  .chips { display: flex; gap: var(--sp-3); }
  .chip {
    appearance: none;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    background: var(--bg-2);
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    padding: var(--sp-3);
    cursor: pointer;
    text-align: left;
  }
  .chip-nm { font-family: var(--font-mono); color: var(--fg-0); font-weight: 600; }
  .chip-desc { font-size: var(--text-10); color: var(--fg-3); }
  .chip:hover:not(:disabled) { border-color: var(--line-2); }
  .chip:disabled { opacity: 0.4; cursor: not-allowed; }
  .chip.on {
    border-color: var(--accent);
    background: var(--accent-tint);
  }
  .chip.on .chip-nm { color: var(--accent-hi); }

  .seg-range {
    display: flex;
    border: 1px solid var(--line-1);
    border-radius: var(--r-sm);
    overflow: hidden;
    box-shadow: var(--shadow-inset);
  }
  .seg-range button {
    flex: 1;
    appearance: none;
    background: var(--bg-0);
    color: var(--fg-2);
    border: none;
    border-right: 1px solid var(--line-1);
    padding: var(--sp-3);
    cursor: pointer;
    font-size: var(--text-11);
  }
  .seg-range button:last-child { border-right: none; }
  .seg-range button:hover { color: var(--fg-0); }
  .seg-range button.on {
    background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
    color: var(--fg-0);
  }

  .bytes-block {
    background: var(--bg-0);
    border: 1px solid var(--line-0);
    border-radius: var(--r-sm);
    padding: var(--sp-4);
    font-size: var(--text-10);
    color: var(--fg-2);
    line-height: 1.6;
  }
  .bytes-block .ok { color: var(--meter-ok); }
  .bytes-block .hl { color: var(--fg-0); }
  .bytes-block .note { color: var(--fg-3); margin-top: var(--sp-2); }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    padding: var(--sp-4) var(--sp-5);
    border-top: 1px solid var(--line-0);
    background: var(--bg-0);
  }
  .summary { color: var(--fg-2); font-size: var(--text-11); }
  .summary .k { color: var(--fg-3); letter-spacing: 0.06em; }
  .summary .v { color: var(--fg-1); }
  .actions { display: flex; gap: var(--sp-3); }
</style>
