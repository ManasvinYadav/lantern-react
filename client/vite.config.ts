import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same-origin relative paths in src/api/* (and the WS hook, once built)
    // depend on this proxy in dev — production instead serves the built
    // client from the same Fastify origin as the API, so no host is ever
    // hardcoded client-side either way. 7654 matches config.ts's
    // LANTERN_PORT default.
    proxy: {
      '/api': 'http://localhost:7654',
      '/ws': { target: 'ws://localhost:7654', ws: true },
    },
  },
})
