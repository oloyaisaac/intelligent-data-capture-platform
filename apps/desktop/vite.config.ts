import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Desktop renderer build.
 *
 * In development the renderer talks to the backend through this dev server's `/api` proxy, so the
 * browser stays same-origin and the backend needs no CORS exception for the app. Production builds
 * are loaded from disk by the Electron shell (see src/main/electron-main.ts).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.IDCP_API_PROXY ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
