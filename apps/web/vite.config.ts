import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: gateway, changeOrigin: false },
      '/ws': { target: gateway.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
