// Phase-9 M4 — collab awareness state for Svelte components.
//
// `Awareness` (from y-protocols) holds a Map<clientId, state>. This
// module bridges that into a Svelte 5 $state-backed reactive view so
// components can render peer cursors / selections / avatars without
// every caller managing its own event listener.

import type { Awareness } from 'y-protocols/awareness';

export interface PeerUser {
  /// Stable per-device id (Phase 11) — the key the owner grants edit
  /// access to. Optional for back-compat with pre-Phase-11 peers.
  id?: string;
  name: string;
  color: string;
}

export interface PeerPianoCell {
  trackIdx: number;
  midi: number;
  col: number;
}

export interface PeerState {
  user?: PeerUser;
  /// Index of the track this peer currently has selected. Drives the
  /// ghost-border in TrackList rows.
  selectedTrackIdx?: number;
  /// Last cell this peer hovered / clicked in the piano-roll. Drives
  /// the ghost-cell overlay in PianoRoll.
  pianoCell?: PeerPianoCell;
  /// Phase-9 M3 — shared transport state. `hostId` carries the
  /// awareness clientID of whoever pressed play/stop most recently;
  /// `startedAtMs` is that client's local Date.now() at the press.
  /// Followers compare hostId against their own awareness clientID
  /// to know whether the update came from somewhere else.
  transport?: TransportState;
}

export interface TransportState {
  playing: boolean;
  hostId: number;
  startedAtMs: number;
}

export interface PeerEntry {
  id: number;
  state: PeerState;
}

export interface CollabState {
  peers: PeerEntry[];
  setSelectedTrack(idx: number | null): void;
  setPianoCell(cell: PeerPianoCell | null): void;
  /// Broadcast our local transport state to peers.
  setTransport(state: TransportState | null): void;
  /// Most recent non-self transport announcement, by startedAtMs.
  /// Followers apply it; the press-most-recently host ignores it
  /// (their own awareness update doesn't appear here).
  latestPeerTransport: TransportState | null;
  /// Our awareness client id — caller compares against `hostId` to
  /// know whether an incoming transport state is their own broadcast.
  selfId: number | null;
  destroy(): void;
}

export function createCollabState(awareness: Awareness | null): CollabState {
  let peers = $state<PeerEntry[]>([]);
  let latestPeerTransport = $state<TransportState | null>(null);

  function refresh() {
    if (!awareness) {
      peers = [];
      latestPeerTransport = null;
      return;
    }
    const out: PeerEntry[] = [];
    const selfId = awareness.clientID;
    for (const [id, state] of awareness.getStates()) {
      if (id === selfId) continue;
      out.push({ id, state: (state as PeerState) ?? {} });
    }
    // Stable order — by clientID — so the avatar list doesn't shuffle
    // every render.
    out.sort((a, b) => a.id - b.id);
    peers = out;

    // Recompute the most recent peer-published transport state. A
    // press-takeover (a peer hits Play after someone else was host)
    // appears as a higher `startedAtMs` and wins. Local presses
    // don't show up here because `peers` already excludes self.
    let latest: TransportState | null = null;
    for (const p of peers) {
      const t = p.state.transport;
      if (!t) continue;
      if (!latest || t.startedAtMs > latest.startedAtMs) latest = t;
    }
    latestPeerTransport = latest;
  }

  const onChange = () => refresh();
  awareness?.on('change', onChange);
  refresh();

  function setLocalField<K extends keyof PeerState>(key: K, value: PeerState[K] | null) {
    if (!awareness) return;
    if (value == null) {
      // Awareness has no native "remove field" — set to undefined
      // by writing through the full state minus the key. Cheaper:
      // re-publish the rest as-is.
      const existing = (awareness.getLocalState() ?? {}) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _drop, ...rest } = existing;
      awareness.setLocalState(rest);
    } else {
      awareness.setLocalStateField(key, value);
    }
  }

  return {
    get peers() { return peers; },
    get latestPeerTransport() { return latestPeerTransport; },
    get selfId() { return awareness?.clientID ?? null; },
    setSelectedTrack(idx) { setLocalField('selectedTrackIdx', idx); },
    setPianoCell(cell) { setLocalField('pianoCell', cell); },
    setTransport(state) { setLocalField('transport', state); },
    destroy() {
      awareness?.off('change', onChange);
    },
  };
}
