import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development-only CSP. The packaged build gets a stricter API-origin-specific policy from the
// Electron protocol response header; it must not inherit the development websocket allowance.
const developmentCsp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self' ws:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Desktop renderer build.
 *
 * In development the renderer talks to the backend through this dev server's `/api` proxy, so the
 * browser stays same-origin and the backend needs no CORS exception for the dev server. Packaged
 * builds are served over the secure `app://idcp` origin by the Electron shell; production CORS must
 * allow that origin (see `DEPLOYMENT.md` §7).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    headers: { 'Content-Security-Policy': developmentCsp },
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // React Fast Refresh injects an inline preamble that our development CSP blocks. Disable it
    // rather than weakening script-src; reload the page after renderer changes.
    hmr: false,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.IDCP_API_PROXY ?? 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    headers: { 'Content-Security-Policy': developmentCsp },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
