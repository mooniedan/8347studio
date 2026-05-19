// Phase-9 M2 — remote (cloud) asset store client.
//
// Pairs with the local OPFS store (`asset-store.ts`). When a peer
// records / imports an audio asset, the OPFS write is mirrored to
// the configured bucket via a fire-and-forget `PUT /asset/<hash>`.
// When another peer opens the project, any referenced hash that's
// missing from their OPFS triggers a `GET /asset/<hash>` and a
// re-cache into OPFS so the engine can decode it.
//
// The bucket is just an HTTP server with `PUT` + `GET` on
// `/asset/<hash>` — implemented by services/sync-server in M2 with
// in-memory storage. Production deployments swap in an S3 / R2
// bucket via the same URL shape.

export interface RemoteAssetStore {
  upload(hash: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  download(hash: string): Promise<Uint8Array | null>;
}

/// Read the asset-bucket base URL the same way `syncUrlForRoom`
/// reads the sync base — `?assetBase=` query override (used by
/// Playwright fixtures) wins, then env var, then null.
function readBaseUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('assetBase');
    if (override) return override;
  } catch { /* SSR / sandbox */ }
  const env = import.meta.env as Record<string, string | undefined>;
  // Prefer a dedicated env var, but derive from VITE_SYNC_URL when
  // the sync server bundles the asset endpoints (dev:share). Swap
  // `ws[s]://` → `http[s]://` so HTTP routes resolve against the
  // same host:port.
  if (env.VITE_ASSET_BUCKET_URL) return env.VITE_ASSET_BUCKET_URL;
  if (env.VITE_SYNC_URL) {
    return env.VITE_SYNC_URL.replace(/^ws/, 'http');
  }
  return null;
}

let active: RemoteAssetStore | null = null;

/// Initialize the module-level remote store. Returns null when no
/// bucket URL is configured — local-only mode, no remote sync. The
/// store is reset on tear-down (project switch) so test isolation
/// stays clean.
export function configureRemoteAssetStore(): RemoteAssetStore | null {
  const base = readBaseUrl();
  if (!base) {
    active = null;
    return null;
  }
  const env = import.meta.env as Record<string, string | undefined>;
  const token = env.VITE_SYNC_TOKEN;
  const trimmed = base.replace(/\/$/, '');
  const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : '';

  const store: RemoteAssetStore = {
    async upload(hash, bytes, contentType = 'application/octet-stream') {
      const res = await fetch(`${trimmed}/asset/${hash}${tokenSuffix}`, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: bytes as unknown as BodyInit,
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`asset upload ${hash}: ${res.status}`);
      }
    },
    async download(hash) {
      const res = await fetch(`${trimmed}/asset/${hash}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`asset download ${hash}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
  active = store;
  return store;
}

export function getRemoteAssetStore(): RemoteAssetStore | null {
  return active;
}

export function clearRemoteAssetStore(): void {
  active = null;
}
