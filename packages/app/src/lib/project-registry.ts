// Multi-project registry. Each project is a Y.Doc bound to its own
// IndexedDB store name; this module keeps the per-machine list of
// projects (id / docName / display name / timestamps) in localStorage
// and offers the create / switch / rename / delete operations the
// UI calls.
//
// The Phase-1 single-project setup wrote everything to the IDB store
// `8347-studio-project`. Existing users keep that data — we register
// it as the project with id `default` and keep its docName unchanged
// so no migration / data move runs.

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

const STORAGE_KEY = '8347-studio-projects';
export const LEGACY_DOC_NAME = '8347-studio-project';
export const DEFAULT_PROJECT_ID = 'default';
/// Reserved id for the in-memory demo session. The demo never lives
/// in the registry — clicking ★ Demo Song always re-seeds a fresh,
/// ephemeral Y.Doc with this id. Editing the demo triggers a
/// "save as" prompt that forks into a real registered project.
export const DEMO_PROJECT_ID = '__demo__';
/// Warn the user when archived projects exceed this many bytes.
export const TRASH_WARN_BYTES = 100 * 1024 * 1024; // 100 MB

export type SeedMode = 'blank' | 'demo';

export interface ProjectInfo {
  id: string;
  docName: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  /// Archive timestamp. Soft-deleted projects keep their IDB store
  /// until purged from the trash.
  archivedAt?: number | null;
  /// Y.Doc state size at archive time (bytes). Used for the trash
  /// total + warning banner — the doc isn't being edited any more
  /// so the value stays representative.
  archivedSize?: number | null;
  /// One-shot hint for the seed used when the Y.Doc is first created.
  /// Consumed by createProject() and then cleared (the doc has been
  /// seeded; the flag would just confuse later boots).
  seed?: SeedMode;
}

export interface Registry {
  projects: ProjectInfo[];
  lastOpenedId: string | null;
}

function emptyRegistry(): Registry {
  return { projects: [], lastOpenedId: null };
}

export function loadRegistry(): Registry {
  if (typeof localStorage === 'undefined') return emptyRegistry();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyRegistry();
  try {
    const parsed = JSON.parse(raw) as Registry;
    if (!Array.isArray(parsed.projects)) return emptyRegistry();
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(r: Registry): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
}

/// Make sure there's at least one project on disk. If a legacy
/// single-project IDB store is implied (registry empty), register it
/// as the default project — its data stays where it is.
export function ensureDefaultProject(): Registry {
  let r = loadRegistry();
  if (r.projects.length === 0) {
    const now = Date.now();
    r = {
      projects: [
        {
          id: DEFAULT_PROJECT_ID,
          docName: LEGACY_DOC_NAME,
          name: 'My Project',
          createdAt: now,
          lastOpenedAt: now,
        },
      ],
      lastOpenedId: DEFAULT_PROJECT_ID,
    };
    saveRegistry(r);
  } else if (!r.lastOpenedId || !r.projects.some((p) => p.id === r.lastOpenedId)) {
    r.lastOpenedId = r.projects[0].id;
    saveRegistry(r);
  }
  return r;
}

function makeId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `p_${rnd}_${stamp}`;
}

export function createProjectInfo(name: string, opts: { seed?: SeedMode } = {}): ProjectInfo {
  const id = makeId();
  const now = Date.now();
  const info: ProjectInfo = {
    id,
    docName: `${LEGACY_DOC_NAME}-${id}`,
    name: name.trim() || 'Untitled',
    createdAt: now,
    lastOpenedAt: now,
  };
  if (opts.seed) info.seed = opts.seed;
  const r = loadRegistry();
  r.projects.push(info);
  r.lastOpenedId = id;
  saveRegistry(r);
  return info;
}

/// Clear the one-shot `seed` hint after the doc has been created.
/// Called by the boot path so subsequent reloads of the same project
/// don't re-trigger seeding.
export function clearSeedHint(id: string): void {
  const r = loadRegistry();
  const p = r.projects.find((x) => x.id === id);
  if (!p || p.seed == null) return;
  delete p.seed;
  saveRegistry(r);
}

export function renameProjectInRegistry(id: string, name: string): void {
  const r = loadRegistry();
  const p = r.projects.find((x) => x.id === id);
  if (!p) return;
  p.name = name.trim() || p.name;
  saveRegistry(r);
}

export function setLastOpenedProject(id: string): void {
  const r = loadRegistry();
  if (!r.projects.some((p) => p.id === id)) return;
  r.lastOpenedId = id;
  const p = r.projects.find((x) => x.id === id);
  if (p) p.lastOpenedAt = Date.now();
  saveRegistry(r);
}

/// Listing helpers — active = not archived; archived = in trash.
export function activeProjects(r: Registry = loadRegistry()): ProjectInfo[] {
  return r.projects.filter((p) => !p.archivedAt);
}

export function archivedProjects(r: Registry = loadRegistry()): ProjectInfo[] {
  return r.projects.filter((p) => !!p.archivedAt);
}

export function trashSizeBytes(r: Registry = loadRegistry()): number {
  return archivedProjects(r).reduce((s, p) => s + (p.archivedSize ?? 0), 0);
}

/// Soft-delete: mark archived + record current Y.Doc state size for
/// the trash readout. The IDB store stays — purgeProject drops it
/// when the user empties trash. If `id` was last-opened, picks the
/// next active project.
export async function archiveProject(id: string): Promise<void> {
  const r = loadRegistry();
  const p = r.projects.find((x) => x.id === id);
  if (!p || p.archivedAt) return;
  p.archivedAt = Date.now();
  p.archivedSize = await computeDocSize(p.docName);
  if (r.lastOpenedId === id) {
    r.lastOpenedId = activeProjects(r)[0]?.id ?? null;
  }
  saveRegistry(r);
}

/// Restore from trash. Clears archive markers; project shows up in
/// the main list again on next read.
export function restoreProject(id: string): void {
  const r = loadRegistry();
  const p = r.projects.find((x) => x.id === id);
  if (!p || !p.archivedAt) return;
  p.archivedAt = null;
  p.archivedSize = null;
  saveRegistry(r);
}

/// Permanent delete — removes from registry and drops the IDB store.
/// Returns the docName for callers that want to do additional cleanup.
export async function purgeProject(id: string): Promise<string | null> {
  const r = loadRegistry();
  const idx = r.projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const [removed] = r.projects.splice(idx, 1);
  if (r.lastOpenedId === id) {
    r.lastOpenedId = activeProjects(r)[0]?.id ?? null;
  }
  saveRegistry(r);
  await deleteProjectStorage(removed.docName);
  return removed.docName;
}

/// Permanently empty the trash. Returns the count of purged projects.
export async function emptyTrash(): Promise<number> {
  const trashed = archivedProjects();
  for (const p of trashed) {
    await purgeProject(p.id);
  }
  return trashed.length;
}

async function computeDocSize(docName: string): Promise<number> {
  // Open the IDB-backed Y.Doc just long enough to read its state
  // size; close cleanly so we don't keep an extra connection alive.
  try {
    const doc = new Y.Doc();
    const provider = new IndexeddbPersistence(docName, doc);
    await provider.whenSynced;
    const bytes = Y.encodeStateAsUpdate(doc).byteLength;
    provider.destroy();
    doc.destroy();
    return bytes;
  } catch {
    return 0;
  }
}

/// Wipe a Y.Doc's IndexedDB store. Uses indexedDB.deleteDatabase
/// directly — IndexeddbPersistence creates one database per docName.
export async function deleteProjectStorage(docName: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(docName);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
