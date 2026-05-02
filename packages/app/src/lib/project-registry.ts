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

const STORAGE_KEY = '8347-studio-projects';
export const LEGACY_DOC_NAME = '8347-studio-project';
export const DEFAULT_PROJECT_ID = 'default';

export interface ProjectInfo {
  id: string;
  docName: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
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

export function createProjectInfo(name: string): ProjectInfo {
  const id = makeId();
  const now = Date.now();
  const info: ProjectInfo = {
    id,
    docName: `${LEGACY_DOC_NAME}-${id}`,
    name: name.trim() || 'Untitled',
    createdAt: now,
    lastOpenedAt: now,
  };
  const r = loadRegistry();
  r.projects.push(info);
  r.lastOpenedId = id;
  saveRegistry(r);
  return info;
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

/// Remove from registry. Returns the docName so the caller can drop
/// the IDB store. If `id` was last-opened, the next project in the
/// list becomes last-opened (or null when nothing remains).
export function removeProjectFromRegistry(id: string): string | null {
  const r = loadRegistry();
  const idx = r.projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const [removed] = r.projects.splice(idx, 1);
  if (r.lastOpenedId === id) {
    r.lastOpenedId = r.projects[0]?.id ?? null;
  }
  saveRegistry(r);
  return removed.docName;
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
