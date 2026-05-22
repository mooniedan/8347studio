import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import basicSsl from '@vitejs/plugin-basic-ssl'

// COOP/COEP enables crossOriginIsolated, required for SharedArrayBuffer
// (used by the audio-engine SAB ring in M3+).
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
  configurePreviewServer(server: import('vite').PreviewServer) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
}

// `pnpm dev:share` (Phase-9 LAN-testing mode) sets SHARE_MODE=1 to bind
// Vite to 0.0.0.0 so other devices on the LAN can reach it.
//
// HTTPS is required even on the LAN: current Chromium ignores COOP/COEP
// on a non-trustworthy origin (plain-HTTP, non-localhost), so
// crossOriginIsolated would be false → no SharedArrayBuffer, and
// `AudioContext.audioWorklet` is undefined outside a secure context.
// A self-signed cert (one "proceed" click per device) makes the LAN-IP
// origin a secure context, restoring both.
//
// The sync server is reached SAME-ORIGIN over `wss://<lan>:8347/sync`,
// proxied to the local ws sync server below — this sidesteps the
// mixed-content trap (an https page can't open a `ws://` socket) without
// needing TLS on the sync server itself.
const shareMode = process.env.SHARE_MODE === '1';
const syncPort = process.env.SYNC_PORT ? Number(process.env.SYNC_PORT) : 1234;

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), basicSsl(), crossOriginIsolation],
  server: {
    port: 8347,
    strictPort: true,
    host: shareMode ? '0.0.0.0' : 'localhost',
    proxy: shareMode
      ? {
          '/sync': {
            target: `ws://localhost:${syncPort}`,
            ws: true,
            changeOrigin: true,
            rewrite: (p) => p.replace(/^\/sync/, ''),
          },
        }
      : undefined,
  },
})
