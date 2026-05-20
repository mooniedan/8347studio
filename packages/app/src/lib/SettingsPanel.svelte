<script lang="ts">
  import { untrack } from 'svelte';
  import {
    type Project,
    type MidiBinding,
    getTrackName,
    listMidiBindings,
    removeMidiBinding,
  } from './project';

  /**
   * Phase-10 M6 — Settings modal, MIDI tab.
   *
   * Lists connected + remembered devices, every CC → param binding,
   * and the MIDI Learn affordance. Empty state appears when the
   * project has no bindings yet. Future tabs (audio I/O, plugins,
   * appearance) plug into the same `<aside>` container by adding to
   * the `tabs` array; for now MIDI is the only tab so it renders
   * un-tabbed.
   */
  const {
    project,
    open,
    midiStatus,
    midiDevices,
    selectedMidiId,
    learnActive,
    learnPendingCC,
    onEnableMidi,
    onSelectMidiDevice,
    onToggleLearn,
    onClose,
  }: {
    project: Project;
    open: boolean;
    midiStatus: 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported';
    midiDevices: { id: string; name: string }[];
    selectedMidiId: string | null;
    learnActive: boolean;
    learnPendingCC: number | null;
    onEnableMidi: () => void;
    onSelectMidiDevice: (id: string | null) => void;
    onToggleLearn: () => void;
    onClose: () => void;
  } = $props();

  /// Reactive mirror of the Y.Doc binding list. Re-reads whenever
  /// `meta.midiBindings` changes (set + remove both fire `observeDeep`).
  let bindings = $state<{ cc: number; binding: MidiBinding }[]>(
    untrack(() => listMidiBindings(project)),
  );
  $effect(() => {
    const refresh = () => { bindings = listMidiBindings(project); };
    refresh();
    project.meta.observeDeep(refresh);
    return () => project.meta.unobserveDeep(refresh);
  });

  /// Display label for a binding's target. Track names live in the
  /// Y.Doc so we read fresh each render rather than caching.
  function bindingLabel(b: MidiBinding): string {
    const name = getTrackName(project, b.trackIdx) ?? `track ${b.trackIdx}`;
    return `${name} · param ${b.paramId}`;
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  /// Window-level Escape listener — modal divs don't receive keys
  /// unless focused, and we don't want to force-focus on every
  /// open. Listener is bound only while the panel is open so it
  /// doesn't steal Esc from background contexts.
  $effect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

{#if open}
  <div
    class="backdrop"
    data-testid="settings-backdrop"
    onclick={onBackdropClick}
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
  >
    <aside class="panel" data-testid="settings-panel">
      <header class="head">
        <h2>Settings</h2>
        <button
          class="close"
          data-testid="settings-close"
          onclick={onClose}
          aria-label="Close settings"
        >×</button>
      </header>

      <nav class="tabs" aria-label="Settings tabs">
        <button class="tab active" data-testid="settings-tab-midi">MIDI</button>
      </nav>

      <section class="tab-body" data-testid="settings-midi-body">
        <h3>Devices</h3>
        <div class="row">
          {#if midiStatus === 'unsupported'}
            <span class="muted" data-testid="settings-midi-unsupported">
              This browser doesn't expose Web MIDI.
            </span>
          {:else if midiStatus === 'idle'}
            <button
              class="btn"
              data-testid="settings-enable-midi"
              onclick={onEnableMidi}
            >Enable MIDI</button>
            <span class="muted">Grants access to connected controllers.</span>
          {:else if midiStatus === 'requesting'}
            <span class="muted">Requesting permission…</span>
          {:else if midiStatus === 'denied'}
            <span class="muted">Permission denied. Re-enable in browser settings.</span>
          {:else if midiDevices.length === 0}
            <span class="muted" data-testid="settings-midi-empty-devices">
              No MIDI devices detected. Plug one in or refresh.
            </span>
          {:else}
            <label class="field">
              <span class="lbl">Active input</span>
              <select
                data-testid="settings-midi-device-select"
                value={selectedMidiId ?? '__all__'}
                onchange={(e) => {
                  const v = (e.currentTarget as HTMLSelectElement).value;
                  onSelectMidiDevice(v === '__all__' ? null : v);
                }}
              >
                <option value="__all__">All devices</option>
                {#each midiDevices as d (d.id)}
                  <option value={d.id}>{d.name}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>

        <h3>Controller map</h3>
        <div class="row">
          <button
            class="btn"
            class:active={learnActive}
            data-testid="settings-midi-learn-toggle"
            onclick={onToggleLearn}
            aria-pressed={learnActive}
          >
            {#if learnActive && learnPendingCC != null}
              CC{learnPendingCC} → pick param…
            {:else if learnActive}
              Learn — wiggle a controller
            {:else}
              MIDI Learn
            {/if}
          </button>
          <span class="muted">
            Wiggle a knob, then click any plugin parameter to bind.
          </span>
        </div>

        {#if bindings.length === 0}
          <div class="empty" data-testid="settings-midi-bindings-empty">
            No controller bindings yet. Click <strong>MIDI Learn</strong>,
            wiggle a knob, then click a plugin parameter to bind it.
          </div>
        {:else}
          <ul class="bindings" data-testid="settings-midi-bindings">
            {#each bindings as { cc, binding } (cc)}
              <li class="binding" data-testid={`settings-midi-binding-${cc}`}>
                <span class="cc mono">CC{cc}</span>
                <span class="arrow">→</span>
                <span class="target">{bindingLabel(binding)}</span>
                <button
                  class="unbind"
                  data-testid={`settings-midi-unbind-${cc}`}
                  onclick={() => removeMidiBinding(project, cc)}
                  aria-label={`Remove binding for CC${cc}`}
                >×</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </aside>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9000;
  }
  .panel {
    width: min(560px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    background: #15171a;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    color: #ddd;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a2a;
  }
  .head h2 {
    margin: 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #aaa;
  }
  .close {
    appearance: none;
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #888;
    width: 22px;
    height: 22px;
    line-height: 18px;
    text-align: center;
    cursor: pointer;
    font-size: 14px;
    padding: 0;
  }
  .close:hover { color: #fff; border-color: #555; }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 6px 14px 0;
    border-bottom: 1px solid #2a2a2a;
  }
  .tab {
    appearance: none;
    background: transparent;
    color: #aaa;
    border: 1px solid #2a2a2a;
    border-bottom: none;
    padding: 5px 10px;
    cursor: pointer;
    font: 11px system-ui, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tab.active {
    background: #15171a;
    color: #ddd;
    border-color: #555;
  }
  .tab-body { padding: 12px 14px; }
  .tab-body h3 {
    margin: 8px 0 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0 10px;
  }
  .btn {
    appearance: none;
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 4px 10px;
    cursor: pointer;
    font: 11px system-ui, sans-serif;
  }
  .btn:hover { background: #232323; }
  .btn.active {
    border-color: #ff8c00;
    color: #ffb066;
    background: #2a160a;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .lbl { color: #888; font-size: 10px; }
  select {
    background: #1a1a1a;
    color: #ddd;
    border: 1px solid #2a2a2a;
    padding: 2px 4px;
    font: 11px ui-monospace, monospace;
  }
  .muted { color: #777; font-size: 11px; }
  .empty {
    color: #777;
    font-style: italic;
    border: 1px dashed #2a2a2a;
    padding: 14px;
    text-align: center;
    margin-top: 6px;
  }
  .bindings {
    list-style: none;
    padding: 0;
    margin: 6px 0 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .binding {
    display: grid;
    grid-template-columns: max-content max-content 1fr max-content;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
  }
  .cc {
    color: #ff8c00;
    background: #2a160a;
    border: 1px solid #4a2a14;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .mono { font-family: ui-monospace, monospace; }
  .arrow { color: #666; }
  .target { color: #ddd; }
  .unbind {
    appearance: none;
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #888;
    width: 18px;
    height: 18px;
    line-height: 16px;
    text-align: center;
    cursor: pointer;
    padding: 0;
    font-size: 12px;
  }
  .unbind:hover { color: #ff8585; border-color: #ff8585; }
</style>
