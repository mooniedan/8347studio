// Phase-6 M1+M2: cross-window satellite contract + BroadcastChannel
// transport for the project Y.Doc.
//
// Architecture:
//   - The *root* window owns the audio engine, MIDI, OPFS, and (Phase 8)
//     network sync. It also owns the canonical Y.Doc.
//   - *Satellites* are pure view + intent: PIP transport (M3), popup
//     panels (M4), and Phase-8 collaborators. They hold a read-only
//     Y.Doc replica that mirrors root via BroadcastChannel.
//   - Writes always flow root → root.Y.Doc → BroadcastChannel.
//     Satellites send `SatelliteIntent` commands to root; root applies
//     them to its Y.Doc and the resulting update reaches every replica
//     in the broadcast group.
//
// Origin tagging on Y.Doc updates avoids the obvious echo loop: root
// only re-broadcasts updates that didn't originate from a remote apply.

import * as Y from 'yjs';

const CHANNEL_NAME = '8347-studio-sync';
const REMOTE_ORIGIN = 'satellite-remote';

export type SatelliteIntent =
  | { kind: 'transport'; play: boolean }
  | { kind: 'setBpm'; bpm: number }
  | { kind: 'locate'; tick: number }
  | { kind: 'setMasterGain'; gain: number }
  | { kind: 'setTrackGain'; track: number; gain: number }
  | { kind: 'setTrackMute'; track: number; mute: boolean }
  | { kind: 'setTrackSolo'; track: number; solo: boolean };

interface DocUpdateMsg {
  type: 'doc-update';
  bytes: Uint8Array;
}
interface DocSnapshotMsg {
  type: 'doc-snapshot';
  bytes: Uint8Array;
}
interface IntentMsg {
  type: 'intent';
  intent: SatelliteIntent;
}
interface RequestSnapshotMsg {
  type: 'request-snapshot';
}
interface AwarenessMsg {
  type: 'awareness';
  windowId: string;
  state: AwarenessState;
}

type SyncMsg =
  | DocUpdateMsg
  | DocSnapshotMsg
  | IntentMsg
  | RequestSnapshotMsg
  | AwarenessMsg;

export interface AwarenessState {
  kind: 'root' | 'pip' | 'popup';
  /// String label for whichever panel currently holds focus in this
  /// window — root uses the selected track kind, satellites use their
  /// hosting panel name.
  focusedPanel?: string;
  /// Ephemeral playhead position. Phase-6 M5 uses this to scrub
  /// across windows without writing to the persistent Y.Doc.
  playheadTick?: number;
  selection?: string | null;
}

export interface RootHandle {
  /// Publish this root's awareness state (kind: 'root', plus playhead
  /// tick / focused panel / selection). Phase-6 M5.
  publishAwareness(state: AwarenessState): void;
  /// Subscribe to awareness updates from other windows.
  onAwareness(cb: (windowId: string, state: AwarenessState) => void): () => void;
  destroy(): void;
}

export interface SatelliteHandle {
  /// Apply an intent on the satellite — sends to root.
  dispatch(intent: SatelliteIntent): void;
  /// Publish this satellite's awareness state to other windows.
  setAwareness(state: AwarenessState): void;
  /// Subscribe to awareness updates from other windows.
  onAwareness(cb: (windowId: string, state: AwarenessState) => void): () => void;
  destroy(): void;
}

export interface RootIntentHandler {
  (intent: SatelliteIntent): void;
}

/// Attach root-side cross-window transport. Returns a destroy handle.
export function attachRootSync(
  doc: Y.Doc,
  onIntent: RootIntentHandler,
): RootHandle {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  const windowId = makeWindowId();
  const awarenessSubs = new Set<(id: string, s: AwarenessState) => void>();

  const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    const msg: DocUpdateMsg = { type: 'doc-update', bytes: update };
    ch.postMessage(msg);
  };
  doc.on('update', onLocalUpdate);

  ch.onmessage = (ev) => {
    const msg = ev.data as SyncMsg;
    if (msg.type === 'intent') {
      try {
        onIntent(msg.intent);
      } catch (err) {
        console.warn('intent handler threw', err);
      }
    } else if (msg.type === 'request-snapshot') {
      const bytes = Y.encodeStateAsUpdate(doc);
      const out: DocSnapshotMsg = { type: 'doc-snapshot', bytes };
      ch.postMessage(out);
    } else if (msg.type === 'doc-update') {
      // M4: satellites can write to their replica directly. Apply
      // the update with origin REMOTE_ORIGIN so the root's update
      // observer doesn't bounce it back. Yjs CRDT semantics make
      // any concurrent-edit overlap benign.
      Y.applyUpdate(doc, msg.bytes, REMOTE_ORIGIN);
    } else if (msg.type === 'awareness' && msg.windowId !== windowId) {
      for (const cb of awarenessSubs) cb(msg.windowId, msg.state);
    }
  };

  return {
    publishAwareness(state) {
      const msg: AwarenessMsg = { type: 'awareness', windowId, state };
      ch.postMessage(msg);
    },
    onAwareness(cb) {
      awarenessSubs.add(cb);
      return () => {
        awarenessSubs.delete(cb);
      };
    },
    destroy() {
      doc.off('update', onLocalUpdate);
      awarenessSubs.clear();
      ch.close();
    },
  };
}

/// Attach satellite-side cross-window transport. M1+M2 originally
/// treated the satellite Y.Doc as a read-only mirror; M4 widens it
/// to bidirectional sync so popup-window UIs (Mixer, PianoRoll) can
/// keep using the same project helpers as the root UI without a
/// per-mutation intent enumeration. CRDT properties handle the rare
/// concurrent-edit case benignly.
///
/// Origin tagging stops the obvious echo loop:
///   - Local updates (origin !== REMOTE_ORIGIN) get broadcast.
///   - Received updates apply with origin REMOTE_ORIGIN; the local
///     update event then skips them.
///
/// The intent path (`dispatch`) is still useful for transport — root
/// has audio engine state that's *not* in the Y.Doc — so it stays.
export function attachSatelliteSync(doc: Y.Doc): SatelliteHandle {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  const windowId = makeWindowId();
  const awarenessSubs = new Set<(id: string, s: AwarenessState) => void>();

  const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    const msg: DocUpdateMsg = { type: 'doc-update', bytes: update };
    ch.postMessage(msg);
  };
  doc.on('update', onLocalUpdate);

  ch.onmessage = (ev) => {
    const msg = ev.data as SyncMsg;
    if (msg.type === 'doc-update' || msg.type === 'doc-snapshot') {
      Y.applyUpdate(doc, msg.bytes, REMOTE_ORIGIN);
    } else if (msg.type === 'awareness' && msg.windowId !== windowId) {
      for (const cb of awarenessSubs) cb(msg.windowId, msg.state);
    }
  };
  // Request initial state from root.
  const req: RequestSnapshotMsg = { type: 'request-snapshot' };
  ch.postMessage(req);

  return {
    dispatch(intent) {
      const msg: IntentMsg = { type: 'intent', intent };
      ch.postMessage(msg);
    },
    setAwareness(state) {
      const msg: AwarenessMsg = { type: 'awareness', windowId, state };
      ch.postMessage(msg);
    },
    onAwareness(cb) {
      awarenessSubs.add(cb);
      return () => {
        awarenessSubs.delete(cb);
      };
    },
    destroy() {
      doc.off('update', onLocalUpdate);
      awarenessSubs.clear();
      ch.close();
    },
  };
}

function makeWindowId(): string {
  return `w_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

/// Test affordance: synchronously create a root + satellite pair on a
/// shared in-memory Y.Doc, exercise the contract, and tear down. Used
/// by the Phase-6 M1/M2 spec.
export function createTestPair(): {
  rootDoc: Y.Doc;
  satDoc: Y.Doc;
  satellite: SatelliteHandle;
  root: RootHandle;
  intentLog: SatelliteIntent[];
} {
  const rootDoc = new Y.Doc();
  const satDoc = new Y.Doc();
  const intentLog: SatelliteIntent[] = [];
  const root = attachRootSync(rootDoc, (i) => {
    intentLog.push(i);
  });
  const satellite = attachSatelliteSync(satDoc);
  return { rootDoc, satDoc, satellite, root, intentLog };
}
