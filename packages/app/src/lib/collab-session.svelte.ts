// Phase-9 — collab session lifecycle.
//
// Owns the reactive state for the live-collab session (`activeRoomId`,
// `syncStatus`, awareness peer view, per-machine identity) and the
// actions that drive it (attach to a room, detach, share, update
// identity). App.svelte instantiates one session at boot via
// `createCollabSession(initialRoomId)` and forwards user actions
// through the returned handle.
//
// The handle exposes its reactive fields as getters so Svelte
// templates see them as reactive reads (`session.activeRoomId`,
// `session.user.name`, …).

import { Awareness } from 'y-protocols/awareness';
import {
  attachSync,
  syncUrlForRoom,
  shareableRoomUrl,
  type SyncHandle,
  type SyncStatus,
} from './sync';
import { createCollabState, type CollabState } from './collab.svelte';
import {
  configureRemoteAssetStore,
  clearRemoteAssetStore,
} from './asset-storage-remote';
import type { Project } from './project';

const COLLAB_USER_KEY = 'collab.user.v1';
const COLLAB_PALETTE = [
  '#ff8a3d', '#ffd166', '#06d6a0', '#118ab2',
  '#6f4ef2', '#ef476f', '#26a69a', '#9c89ff',
];

/// Stable per-device identity. `id` is the grant key for collab edit
/// permissions (Phase 11) — it persists across reconnects so a granted
/// editor stays granted. Production accounts will replace the
/// device-minted id with an account id behind the same field.
export interface CollabUser { id: string; name: string; color: string }

function loadCollabUser(): CollabUser {
  try {
    const raw = localStorage.getItem(COLLAB_USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CollabUser>;
      if (parsed.name && parsed.color) {
        // Backfill a stable id for users persisted before Phase 11.
        const id = parsed.id ?? `u_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
        const user = { id, name: parsed.name, color: parsed.color };
        if (!parsed.id) { try { localStorage.setItem(COLLAB_USER_KEY, JSON.stringify(user)); } catch { /* blocked */ } }
        return user;
      }
    }
  } catch { /* localStorage may be blocked */ }
  const fresh: CollabUser = {
    id: `u_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    name: `Anon ${Math.floor(Math.random() * 9000) + 1000}`,
    color: COLLAB_PALETTE[Math.floor(Math.random() * COLLAB_PALETTE.length)],
  };
  // Persist on first use so the identity (and its edit grants) is
  // stable across reloads.
  try { localStorage.setItem(COLLAB_USER_KEY, JSON.stringify(fresh)); } catch { /* blocked */ }
  return fresh;
}

function saveCollabUser(u: CollabUser): void {
  try { localStorage.setItem(COLLAB_USER_KEY, JSON.stringify(u)); }
  catch { /* localStorage may be blocked */ }
}

/// Short, URL-safe room id. 8 chars from a 32-char crockford-style
/// alphabet gives 32^8 ≈ 10^12 — plenty for share-a-link without
/// the noise of a UUID.
function makeRoomId(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += alphabet[b % alphabet.length];
  return out;
}

export interface CollabSession {
  /// Currently joined room id, or null when in local mode.
  readonly activeRoomId: string | null;
  readonly syncStatus: SyncStatus;
  /// Reactive view over peers' awareness state — null outside a
  /// session. Components consume `.peers`, `.setSelectedTrack(...)`,
  /// `.setPianoCell(...)`, etc.
  readonly collab: CollabState | null;
  readonly user: CollabUser;
  /// Bring the session online for `project` under `roomId`. Idempotent;
  /// a previous attachment is torn down first. `onSynced` fires once
  /// when the room's initial state has been applied (used by the
  /// collab boot to seed an empty room).
  attach(
    project: Project,
    roomId: string,
    selectedTrackIdx: number,
    onSynced?: () => void,
  ): void;
  /// Tear the session down without affecting the underlying Y.Doc.
  detach(): void;
  /// Apply name / color edits. Awareness updates immediately so peers
  /// see the new identity without reconnect.
  setUser(next: Partial<CollabUser>): void;
  /// "Share" button handler. If not in a room, mints one and attaches;
  /// either way, copies the full room URL to clipboard and returns it.
  share(project: Project | null, selectedTrackIdx: number): Promise<string | null>;
  /// Called when the host (App.svelte) tears down its project — e.g.
  /// on switch-project. Releases sync + awareness, resets `collab`.
  destroy(): void;
}

export function createCollabSession(initialRoomId: string | null): CollabSession {
  // svelte-ignore state_referenced_locally
  let activeRoomId = $state<string | null>(initialRoomId);
  let syncStatus = $state<SyncStatus>('idle');
  let collabRef = $state<CollabState | null>(null);
  let user = $state<CollabUser>(loadCollabUser());
  let syncHandle: SyncHandle | null = null;
  let syncAwareness: Awareness | null = null;

  function attach(
    project: Project,
    roomId: string,
    selectedTrackIdx: number,
    onSynced?: () => void,
  ): void {
    // Idempotent — tear down any prior attachment first.
    syncHandle?.destroy();
    syncHandle = null;
    collabRef?.destroy();
    collabRef = null;
    syncAwareness?.destroy();
    syncAwareness = null;

    const awareness = new Awareness(project.doc);
    awareness.setLocalStateField('user', { id: user.id, name: user.name, color: user.color });
    // Reflect the user's currently-selected track from the moment we
    // connect so peers see our position without waiting for the next
    // track-row click.
    awareness.setLocalStateField('selectedTrackIdx', selectedTrackIdx);
    syncAwareness = awareness;
    collabRef = createCollabState(awareness);
    syncHandle = attachSync(project.doc, {
      url: syncUrlForRoom(roomId),
      awareness,
      onStatusChange: (s) => { syncStatus = s; },
      onSynced,
    });
    // Phase-9 M2 — turn on cloud asset upload/download so recordings
    // and imports flow between peers.
    configureRemoteAssetStore();
    activeRoomId = roomId;
  }

  function detach(): void {
    collabRef?.destroy();
    collabRef = null;
    syncHandle?.destroy();
    syncHandle = null;
    syncAwareness?.destroy();
    syncAwareness = null;
    syncStatus = 'idle';
    activeRoomId = null;
    clearRemoteAssetStore();
  }

  function setUser(next: Partial<CollabUser>): void {
    user = { ...user, ...next };
    saveCollabUser(user);
    syncAwareness?.setLocalStateField('user', { id: user.id, name: user.name, color: user.color });
  }

  async function share(
    project: Project | null,
    selectedTrackIdx: number,
  ): Promise<string | null> {
    if (!project) return null;
    let roomId = activeRoomId;
    if (!roomId) {
      roomId = makeRoomId();
      attach(project, roomId, selectedTrackIdx);
      // Reflect the live room in the URL bar so refresh keeps the
      // session and casual copies of the bar text are useful.
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomId);
      window.history.replaceState(null, '', url.toString());
    }
    const stringified = shareableRoomUrl(roomId);
    try {
      await navigator.clipboard.writeText(stringified);
    } catch {
      // Clipboard may be blocked (insecure context, denied perms).
      // URL bar still shows the link.
    }
    return stringified;
  }

  function destroy(): void { detach(); }

  return {
    get activeRoomId() { return activeRoomId; },
    get syncStatus() { return syncStatus; },
    get collab() { return collabRef; },
    get user() { return user; },
    attach,
    detach,
    setUser,
    share,
    destroy,
  };
}
