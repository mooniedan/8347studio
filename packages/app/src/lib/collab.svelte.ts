// Phase-9 M4 — collab awareness state for Svelte components.
//
// `Awareness` (from y-protocols) holds a Map<clientId, state>. This
// module bridges that into a Svelte 5 $state-backed reactive view so
// components can render peer cursors / selections / avatars without
// every caller managing its own event listener.

import type { Awareness } from 'y-protocols/awareness';

export interface PeerUser {
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
}

export interface PeerEntry {
  id: number;
  state: PeerState;
}

export interface CollabState {
  peers: PeerEntry[];
  setSelectedTrack(idx: number | null): void;
  setPianoCell(cell: PeerPianoCell | null): void;
  destroy(): void;
}

export function createCollabState(awareness: Awareness | null): CollabState {
  let peers = $state<PeerEntry[]>([]);

  function refresh() {
    if (!awareness) {
      peers = [];
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
    setSelectedTrack(idx) { setLocalField('selectedTrackIdx', idx); },
    setPianoCell(cell) { setLocalField('pianoCell', cell); },
    destroy() {
      awareness?.off('change', onChange);
    },
  };
}
