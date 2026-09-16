import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

/* Dev ports. The defaults are the only ones anyone normally needs; the env
   overrides exist so a second worktree can run its own pair without fighting
   the first for :4300/:4400. PORT is the same variable the server reads, so
   the proxy always points at whichever backend this `npm run dev` started. */
const apiPort = Number(process.env.PORT || 4400)
const webPort = Number(process.env.VITE_PORT || 4300)
const api = `http://localhost:${apiPort}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  /* Vitest reads this file too. The suite drives a real Chromium wherever the
     platform has one (the element, stylesheet, a11y and review tests all render
     a real page), and the first launch in a worker is a cold one: on a loaded
     CI runner that launch runs past the 5s default, and the test killed
     mid-launch takes the next one down with it. Tests that are slow for another
     reason already carry their own budget (70_000 for the restart suites), so
     this only lifts the floor for the ones relying on the default. */
  test: {
    testTimeout: 30_000,
  },
  server: {
    port: webPort,
    /* cargo's build output is huge and, on Windows, its binaries stay locked
       while the shell runs (EBUSY); nothing under it is ever served by vite */
    watch: {
      ignored: ['**/desktop/src-tauri/target/**'],
    },
    /* the doop-sync snippet posts to /ingest from foreign origins; vite
       answers CORS preflights itself before the proxy, so its default
       same-origin policy would block what the express server (prod) allows */
    cors: true,
    proxy: {
      /* changeOrigin stays OFF so the backend sees the web origin's Host and
         better-auth builds OAuth discovery/authorize URLs on that origin —
         the one that serves the login page and that MCP clients connect to */
      '/api': { target: api },
      '/mcp': { target: api },
      '/i': { target: api },
      '/a/': { target: api },
      '/u/': { target: api },
      '/ingest': { target: api },
      '/relay': { target: api },
      '/blog': { target: api },
      '/robots.txt': { target: api },
      '/sitemap.xml': { target: api },
      '/.well-known': { target: api },
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
})
