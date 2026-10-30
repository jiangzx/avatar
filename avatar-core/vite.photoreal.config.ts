import { defineConfig } from 'vite';

export default defineConfig({
  root: 'photoreal',
  base: '/',
  // ORT Web fetches its wasm from the hoisted workspace node_modules.
  server: { host: '127.0.0.1', port: 5174, fs: { allow: ['..', '../..'] } },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', outDir: '../dist-photoreal', emptyOutDir: true, assetsInlineLimit: 0 },
});
