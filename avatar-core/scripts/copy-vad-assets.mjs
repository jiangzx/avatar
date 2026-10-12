// Copies Silero VAD + onnxruntime-web runtime files into public/vad so they are served same-origin.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(pkgRoot, 'public', 'vad');
mkdirSync(out, { recursive: true });

function findDist(pkg) {
  for (const base of [join(pkgRoot, 'node_modules'), join(pkgRoot, '..', 'node_modules')]) {
    const dist = join(base, pkg, 'dist');
    if (existsSync(dist)) return dist;
  }
  throw new Error(`Cannot find ${pkg}/dist; run npm install at the repo root`);
}

const vadDist = findDist('@ricky0123/vad-web');
for (const f of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'silero_vad_legacy.onnx']) {
  cpSync(join(vadDist, f), join(out, f));
}
const ortDist = findDist('onnxruntime-web');
const ortFiles = readdirSync(ortDist).filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f));
for (const f of ortFiles) cpSync(join(ortDist, f), join(out, f));
console.log(`copied ${3 + ortFiles.length} VAD assets to public/vad`);
