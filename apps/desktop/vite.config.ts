import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Desktop renderer build.
 *
 * The renderer is a normal web app: it has no Node access (DESK-001). In development it proxies
 * `/api` to the local backend so the browser talks same-origin and no CORS exceptions are needed.
 * The Electron shell loads the built files from disk in production.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The preview environment serves the app from its own host; do not reject that Host header.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.IDCP_API_PROXY ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
        ws: false,
      },
    },
  },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
