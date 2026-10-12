import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173 },
  optimizeDeps: { exclude: ['onnxruntime-web', '@ricky0123/vad-web'] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: 'index.html', spike: 'spike-aec.html' } },
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
