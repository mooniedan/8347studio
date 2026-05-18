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

// `pnpm dev:share` (Phase-9 LAN-testing mode) sets SHARE_MODE=1 so
// Vite drops the self-signed HTTPS cert and binds to 0.0.0.0. Plain
// HTTP avoids the mixed-content trap when the page tries to WS into
// the sync server, and 0.0.0.0 lets other devices on the LAN reach
// the dev server. SAB still works — crossOriginIsolated only needs
// the COOP/COEP headers, not HTTPS.
const shareMode = process.env.SHARE_MODE === '1';

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), ...(shareMode ? [] : [basicSsl()]), crossOriginIsolation],
  server: {
    port: 8347,
    strictPort: true,
    host: shareMode ? '0.0.0.0' : 'localhost',
  },
})
