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
