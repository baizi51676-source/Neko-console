import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Neko-console frontend build.
 *
 * In development the API lives on the Node server (port 8737), so `/api` is
 * proxied there. That keeps the dev experience identical to production, where
 * the same server serves `dist/` and the API from one origin — meaning cookies
 * work the same way in both.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.NEKO_API ?? 'http://127.0.0.1:8737',
        changeOrigin: false,
        // SSE must not be buffered by the proxy, or metrics arrive in batches.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    sourcemap: false,
  },
});
