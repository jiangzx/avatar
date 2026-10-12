import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 }, // loopback only: the dev page is opened on this machine
  optimizeDeps: { exclude: ['onnxruntime-web', '@ricky0123/vad-web'] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: 'index.html', spike: 'spike-aec.html' } },
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
