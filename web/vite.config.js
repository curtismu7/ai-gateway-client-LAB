import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api and the OAuth callback to the local Express server
// (see ../server) so the browser only ever talks to one origin during
// development, same as production (where the server also serves this app's
// build output). SSE (/api/gateway/events) needs ws:false-safe passthrough,
// which the default http-proxy handles fine for EventSource.
export default defineConfig({
  plugins: [react()],
  // vitest: the component tests under src (the node:test files in test/ run with node --test).
  test: { environment: 'jsdom', include: ['src/**/*.test.jsx'] },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:6880',
    },
  },
});
