// Phase-6 M3: Document Picture-in-Picture transport.
//
// Document PIP is Chromium-only at present (Firefox / Safari users
// fall back to the popup-window path in M4). We feature-detect via
// `documentPictureInPicture in window` and return a stable controller
// that callers can ask `isOpen()` / `open()` / `close()` regardless.
//
// The PIP window is independent — its own document, no shared style
// sheets — so the TransportPipPanel ships its own CSS as `:global`
// inside the component. Bindings are passed by value (function refs
// the panel polls every 100 ms); cross-window Svelte reactivity isn't
// a thing.

import { mount, unmount } from 'svelte';
import DocsPanel from './DocsPanel.svelte';
import TransportPipPanel from './TransportPipPanel.svelte';

export interface PipBindings {
  getPlaying: () => boolean;
  getBpm: () => number;
  getProjectName: () => string;
  play: () => void;
  stop: () => void;
}

export interface PipController {
  isOpen: () => boolean;
  open: () => Promise<void>;
  close: () => void;
  destroy: () => void;
}

interface DocumentPictureInPictureWindow extends Window {
  // Marker — Chromium adds standard Window properties.
}

interface DocumentPictureInPicture {
  requestWindow: (options?: {
    width?: number;
    height?: number;
  }) => Promise<DocumentPictureInPictureWindow>;
}

interface WindowWithPip extends Window {
  documentPictureInPicture?: DocumentPictureInPicture;
}

export function isPipSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'documentPictureInPicture' in (window as WindowWithPip);
}

export function createPipController(bindings: PipBindings): PipController {
  let win: Window | null = null;
  // Svelte 5's mount returns an opaque component instance; we only
  // need it to call unmount.
  let mounted: ReturnType<typeof mount> | null = null;

  const closeMounted = () => {
    if (mounted) {
      try {
        unmount(mounted);
      } catch {
        // PIP window was already torn down.
      }
      mounted = null;
    }
    win = null;
  };

  return {
    isOpen: () => win !== null,
    async open() {
      if (win) return;
      const dpip = (window as WindowWithPip).documentPictureInPicture;
      if (!dpip) throw new Error('Document Picture-in-Picture not supported');
      win = await dpip.requestWindow({ width: 320, height: 96 });
      // PIP windows are independent — no shared stylesheet, so we
      // inject the base reset here. Component-scoped styles travel
      // with the bundle automatically.
      const style = win.document.createElement('style');
      style.textContent = `
        html, body {
          margin: 0;
          background: #0d0d0d;
          color: #ddd;
          font-family: system-ui, sans-serif;
          height: 100vh;
        }
      `;
      win.document.head.appendChild(style);
      const body = win.document.body;
      mounted = mount(TransportPipPanel, {
        target: body,
        props: { bindings },
      });
      win.addEventListener('pagehide', closeMounted);
    },
    close() {
      const w = win;
      if (w) w.close();
      closeMounted();
    },
    destroy() {
      this.close();
    },
  };
}

/// Phase-8 follow-up — Document PIP for the user guide. Same plumbing
/// as the transport PIP (mount a Svelte component inside a popped-out
/// PIP window), just a different component + window size.
///
/// Unlike TransportPipPanel (whose styles are all `:global`), DocsPanel
/// uses Svelte's scoped styles — the generated `<style>` blocks live
/// in the *main* document's head and don't follow the component into
/// the PIP window's document. We copy every stylesheet from the host
/// document into the PIP doc on open; without that the nav stacks on
/// top of the body because the grid layout is missing.
function copyStyleSheetsIntoPip(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
      const style = target.createElement('style');
      style.textContent = rules;
      target.head.appendChild(style);
    } catch {
      // Cross-origin / unreadable sheets — link them by href instead.
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        if (sheet.media.mediaText) link.media = sheet.media.mediaText;
        target.head.appendChild(link);
      }
    }
  }
}

export function createDocsPipController(): PipController {
  let win: Window | null = null;
  let mounted: ReturnType<typeof mount> | null = null;

  const closeMounted = () => {
    if (mounted) {
      try { unmount(mounted); } catch { /* window already gone */ }
      mounted = null;
    }
    win = null;
  };

  return {
    isOpen: () => win !== null,
    async open() {
      if (win) return;
      const dpip = (window as WindowWithPip).documentPictureInPicture;
      if (!dpip) throw new Error('Document Picture-in-Picture not supported');
      // 880 × 760 fits the 220px nav rail + comfortable prose body
      // (~640px content area at default font size).
      win = await dpip.requestWindow({ width: 880, height: 760 });
      copyStyleSheetsIntoPip(win.document);
      const style = win.document.createElement('style');
      style.textContent = `
        html, body {
          margin: 0;
          background: var(--bg-1, #0e0f12);
          color: var(--fg-1, #c8ccd4);
          font-family: var(--font-sans, system-ui, sans-serif);
          height: 100vh;
          overflow: hidden;
        }
        #docs-root { height: 100vh; }
      `;
      win.document.head.appendChild(style);
      // Honor the same favicon + title for clarity in the OS dock.
      win.document.title = '8347 Studio — User Guide';
      const root = win.document.createElement('div');
      root.id = 'docs-root';
      win.document.body.appendChild(root);
      mounted = mount(DocsPanel, { target: root });
      win.addEventListener('pagehide', closeMounted);
    },
    close() {
      const w = win;
      if (w) w.close();
      closeMounted();
    },
    destroy() {
      this.close();
    },
  };
}
