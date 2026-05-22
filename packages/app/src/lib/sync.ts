// Phase-9 M5 — sync client.
//
// Speaks the y-protocols wire format directly to our sync-server
// (see services/sync-server/src/server.mjs). A thin replacement for
// the y-websocket package — fewer features, no reconnect storms, no
// surprise dependencies.
//
// Usage:
//   const handle = attachSync(doc, {
//     url: 'ws://localhost:1234/room/<id>',
//     awareness, // optional
//   });
//   // later
//   handle.destroy();

import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type SyncStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface SyncOptions {
  url: string;
  awareness?: Awareness;
  /// Called whenever the connection state transitions. Drives the
  /// transport-bar status indicator (M5) and later the avatar list
  /// (M4 awareness UI).
  onStatusChange?: (status: SyncStatus) => void;
  /// Fires once, the first time the server's initial state (a sync
  /// step-2) has been applied to the doc. Callers use it to tell
  /// "joined a room that already has content" from "joined an empty
  /// room" — see App's collab boot (seed-if-empty).
  onSynced?: () => void;
  /// Initial reconnect backoff in ms. Doubles up to `maxReconnectMs`.
  initialReconnectMs?: number;
  maxReconnectMs?: number;
}

export interface SyncHandle {
  status: () => SyncStatus;
  destroy: () => void;
}

export function attachSync(doc: Y.Doc, opts: SyncOptions): SyncHandle {
  const initialBackoff = opts.initialReconnectMs ?? 500;
  const maxBackoff = opts.maxReconnectMs ?? 15_000;
  const awareness = opts.awareness ?? null;

  let ws: WebSocket | null = null;
  let destroyed = false;
  let backoff = initialBackoff;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let status: SyncStatus = 'idle';
  let syncedFired = false;

  const setStatus = (next: SyncStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatusChange?.(next);
  };

  const send = (bytes: Uint8Array) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return; // came from the server already
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    send(encoding.toUint8Array(enc));
  };

  const onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === 'server' || !awareness) return;
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(awareness, changed));
    send(encoding.toUint8Array(enc));
  };

  doc.on('update', onDocUpdate);
  awareness?.on('update', onAwarenessUpdate);

  function handleMessage(bytes: Uint8Array) {
    const dec = decoding.createDecoder(bytes);
    const enc = encoding.createEncoder();
    const messageType = decoding.readVarUint(dec);
    switch (messageType) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        const syncType = syncProtocol.readSyncMessage(dec, enc, doc, ws);
        if (encoding.length(enc) > 1) send(encoding.toUint8Array(enc));
        // The server's step-2 carries the room's existing state. Once
        // it lands, the doc reflects whatever the room holds.
        if (!syncedFired && syncType === syncProtocol.messageYjsSyncStep2) {
          syncedFired = true;
          opts.onSynced?.();
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        if (awareness) {
          applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), 'server');
        }
        break;
      }
      default:
        break;
    }
  }

  function scheduleReconnect() {
    if (destroyed) return;
    if (reconnectTimer != null) return;
    setStatus('disconnected');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, maxBackoff);
      open();
    }, backoff);
  }

  function open() {
    if (destroyed) return;
    setStatus('connecting');
    try {
      ws = new WebSocket(opts.url);
    } catch (err) {
      console.warn('sync: WebSocket constructor threw', err);
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      backoff = initialBackoff;
      setStatus('connected');
      // Symmetric handshake — both sides advertise their state vector
      // on connect so each receives the other's missing updates.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      send(encoding.toUint8Array(enc));
      // Push current awareness state so peers see us immediately.
      if (awareness) {
        const clients = Array.from(awareness.getStates().keys());
        if (clients.length > 0) {
          const aenc = encoding.createEncoder();
          encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            aenc,
            encodeAwarenessUpdate(awareness, clients),
          );
          send(encoding.toUint8Array(aenc));
        }
      }
    });

    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
      if (!bytes) return;
      try {
        handleMessage(bytes);
      } catch (err) {
        console.error('sync: message handler threw', err);
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // The 'close' event will follow; reconnect is handled there.
    });
  }

  open();

  return {
    status: () => status,
    destroy() {
      destroyed = true;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      doc.off('update', onDocUpdate);
      awareness?.off('update', onAwarenessUpdate);
      if (awareness) {
        // Drop our own awareness state so peers' avatar lists update
        // immediately on disconnect.
        removeAwarenessStates(awareness, [doc.clientID], 'local');
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        ws = null;
      }
      setStatus('idle');
    },
  };
}

/// Build the WS URL for a given room id. Base URL comes from
/// `import.meta.env.VITE_SYNC_URL` (defaults to ws://localhost:1234)
/// and the room path is appended.
///
/// Test hook: `?syncBase=<ws://…>` in the page URL overrides the base
/// URL. The room path is still appended, so each test can spawn the
/// sync-server on its own random port and share a single override
/// across both clients without baking a build-time env var.
export function syncUrlForRoom(roomId: string): string {
  let base: string | undefined;
  try {
    const params = new URLSearchParams(window.location.search);
    base = params.get('syncBase') ?? undefined;
  } catch { /* SSR / sandbox without window.location */ }
  if (!base) {
    base = (import.meta.env as Record<string, string | undefined>).VITE_SYNC_URL
      ?? 'ws://localhost:1234';
  }
  const token = (import.meta.env as Record<string, string | undefined>).VITE_SYNC_TOKEN;
  const safeId = encodeURIComponent(roomId);
  const url = new URL(`${base.replace(/\/$/, '')}/room/${safeId}`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/// Build a room URL to hand to another device. Starts from the current
/// page URL with `?room=<id>`, but in LAN share mode `dev:share`
/// injects `VITE_SHARE_HOST` (the detected LAN IP) — we swap it into
/// the hostname so a link copied while browsing `localhost` is still
/// reachable from other machines. No-op (current origin) otherwise.
export function shareableRoomUrl(roomId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  const shareHost = (import.meta.env as Record<string, string | undefined>).VITE_SHARE_HOST;
  if (shareHost) url.hostname = shareHost;
  return url.toString();
}
