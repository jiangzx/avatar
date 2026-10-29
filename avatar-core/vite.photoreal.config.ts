import { defineConfig } from 'vite';

export default defineConfig({
  root: 'photoreal',
  base: '/',
  server: { host: '127.0.0.1', port: 5174, fs: { allow: ['..'] } },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', outDir: '../dist-photoreal', emptyOutDir: true, assetsInlineLimit: 0 },
});
