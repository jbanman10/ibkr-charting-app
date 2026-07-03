import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ibkr-chart/types': resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    hmr: {
      port: 5174,   // Run HMR on a separate port so it doesn't conflict with /ws proxy
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          // Prevent ECONNRESET from the backend WS dropping connections
          // from bubbling up as an unhandled error and crashing the dev server.
          proxy.on('error', (_err, _req, socket) => {
            if (socket && typeof (socket as any).end === 'function') {
              (socket as any).end();
            }
          });
        },
      },
    },
  },
});
