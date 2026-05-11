/**
 * Phase 7 M2 — per-machine UI layout preferences (collapsed states +
 * pane widths). Stored in LocalStorage rather than the Y.Doc because
 * layout is a personal/screen-specific concern, not project state.
 *
 * Keys live under the `8347.layout.*` namespace; new keys can be
 * added freely — `read()` is forgiving and returns the supplied
 * default on parse failure.
 */

const PREFIX = '8347.layout.';

export interface LayoutState {
  inspectorCollapsed: boolean;
  drawerExpanded: boolean;
  railWidth: number;
  inspectorWidth: number;
  drawerHeight: number;
}

export const DEFAULTS: LayoutState = {
  inspectorCollapsed: false,
  // Drawer starts expanded so the mixer is visible at-a-glance. Once
  // Phase 7 M3 adds the master stereo meter to the top transport bar,
  // default-collapsed becomes the design intent (the bar is the
  // always-on summary then).
  drawerExpanded: true,
  railWidth: 220,
  inspectorWidth: 280,
  drawerHeight: 320,
};

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readKey<K extends keyof LayoutState>(key: K): LayoutState[K] {
  const s = safeStorage();
  if (!s) return DEFAULTS[key];
  const raw = s.getItem(PREFIX + key);
  if (raw == null) return DEFAULTS[key];
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === typeof DEFAULTS[key]) return parsed as LayoutState[K];
  } catch {
    /* fall through */
  }
  return DEFAULTS[key];
}

function writeKey<K extends keyof LayoutState>(key: K, value: LayoutState[K]): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota / privacy mode — silently drop */
  }
}

/**
 * Construct a Svelte 5 `$state`-backed reactive layout object whose
 * mutations persist to LocalStorage. Returns a getter/setter proxy:
 * read fields normally, assign to fields to persist.
 *
 * Usage:
 *   const layout = createLayoutState();
 *   layout.inspectorCollapsed = true;   // → writes LocalStorage
 *   $: width = layout.inspectorWidth;   // reactive read
 */
export function createLayoutState() {
  const initial: LayoutState = {
    inspectorCollapsed: readKey('inspectorCollapsed'),
    drawerExpanded:     readKey('drawerExpanded'),
    railWidth:          readKey('railWidth'),
    inspectorWidth:     readKey('inspectorWidth'),
    drawerHeight:       readKey('drawerHeight'),
  };
  const state = $state(initial);

  return {
    get inspectorCollapsed() { return state.inspectorCollapsed; },
    set inspectorCollapsed(v: boolean) {
      state.inspectorCollapsed = v;
      writeKey('inspectorCollapsed', v);
    },
    get drawerExpanded() { return state.drawerExpanded; },
    set drawerExpanded(v: boolean) {
      state.drawerExpanded = v;
      writeKey('drawerExpanded', v);
    },
    get railWidth() { return state.railWidth; },
    set railWidth(v: number) {
      state.railWidth = v;
      writeKey('railWidth', v);
    },
    get inspectorWidth() { return state.inspectorWidth; },
    set inspectorWidth(v: number) {
      state.inspectorWidth = v;
      writeKey('inspectorWidth', v);
    },
    get drawerHeight() { return state.drawerHeight; },
    set drawerHeight(v: number) {
      state.drawerHeight = v;
      writeKey('drawerHeight', v);
    },
  };
}

export type LayoutController = ReturnType<typeof createLayoutState>;
