import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = fileURLToPath(new URL('./avatar-assets.json', import.meta.url));
const outputDir = fileURLToPath(new URL('../avatar-core/public/avatars/', import.meta.url));
const deriveScript = fileURLToPath(new URL('./derive-avatar-variant.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const force = process.env.FORCE_AVATAR === '1';

mkdirSync(outputDir, { recursive: true });

function safeName(file) {
  if (typeof file !== 'string' || basename(file) !== file) throw new Error(`invalid asset file: ${file}`);
  return file;
}

function revisionFor(asset) {
  return asset.revision ?? manifest.sourceRevision;
}

function urlFor(asset) {
  return asset.url ?? `${manifest.upstreamBase.replace('{revision}', revisionFor(asset))}/${asset.source}`;
}

for (const asset of manifest.assets) {
  safeName(asset.file);
  if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`invalid sha256 for ${asset.file}`);
  const target = join(outputDir, asset.file);
  if (asset.derived) {
    if (!asset.transform || typeof asset.transform !== 'object') throw new Error(`missing transform for ${asset.file}`);
    const source = join(outputDir, safeName(asset.source));
    if (!existsSync(source)) throw new Error(`missing source for ${asset.file}: ${asset.source}`);
    const result = spawnSync(
      process.execPath,
      [deriveScript, source, target, JSON.stringify(asset.transform)],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error(`derivation failed: ${asset.file}`);
  } else if (force || !existsSync(target)) {
    if (typeof asset.source !== 'string' || !asset.source) throw new Error(`missing source URL for ${asset.file}`);
    const response = await fetch(urlFor(asset), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`download failed: ${asset.file} HTTP ${response.status}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(target);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== asset.sha256) {
    throw new Error(`checksum mismatch: ${asset.file} expected ${asset.sha256} got ${actual} (revision ${revisionFor(asset)})`);
  }
  console.log(`${asset.file} bytes=${bytes.length} sha256=${actual} derived=${asset.derived}`);
}
