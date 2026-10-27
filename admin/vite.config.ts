import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev server only: proxy the admin API to the gateway's loopback admin port.
const adminPort = Number(process.env.ADMIN_PORT ?? '8788');

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: { '/admin/api': { target: `http://127.0.0.1:${adminPort}` } },
  },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  test: { environment: 'jsdom', setupFiles: ['test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'] },
});
