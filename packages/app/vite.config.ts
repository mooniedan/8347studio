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

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), basicSsl(), crossOriginIsolation],
  server: { port: 8347, strictPort: true },
})
