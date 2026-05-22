// Phase-11 M5 — project version history (checkpoints).
//
// Timestamped full-state snapshots (`Y.encodeStateAsUpdate`) stored in
// IndexedDB, keyed by the project's docName. A safety net for messy
// collaboration: browse versions and restore one as a new project
// (restore forks rather than rewinding the live CRDT — a reliable
// recovery without the in-place-rewind complexity). Bounded by pruning
// to the most-recent MAX_CHECKPOINTS per project.

const DB_NAME = '8347-checkpoints';
const STORE = 'checkpoints';
const MAX_CHECKPOINTS = 50;

export interface CheckpointMeta {
  id: number;
  docName: string;
  createdAt: number;
  label: string;
  /// Uncompressed snapshot size, for the version-list readout.
  bytes: number;
}

interface CheckpointRecord {
  id?: number;
  docName: string;
  createdAt: number;
  label: string;
  data: Uint8Array;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('docName', 'docName', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCheckpoint(docName: string, data: Uint8Array, label = ''): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add({ docName, createdAt: Date.now(), label, data } as CheckpointRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  await pruneCheckpoints(docName);
}

export async function listCheckpoints(docName: string): Promise<CheckpointMeta[]> {
  const db = await openDb();
  try {
    const records = await new Promise<CheckpointRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).index('docName').getAll(docName);
      req.onsuccess = () => resolve(req.result as CheckpointRecord[]);
      req.onerror = () => reject(req.error);
    });
    return records
      .map((r) => ({ id: r.id!, docName: r.docName, createdAt: r.createdAt, label: r.label, bytes: r.data.byteLength }))
      .sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

export async function getCheckpointData(id: number): Promise<Uint8Array | null> {
  const db = await openDb();
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result ? (req.result as CheckpointRecord).data : null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function pruneCheckpoints(docName: string): Promise<void> {
  const all = await listCheckpoints(docName); // newest-first
  if (all.length <= MAX_CHECKPOINTS) return;
  const stale = all.slice(MAX_CHECKPOINTS).map((c) => c.id);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const id of stale) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
