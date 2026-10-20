import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AVATAR_CATALOG } from '../src/avatar/catalog.ts';

const assetDir = fileURLToPath(new URL('../public/avatars/', import.meta.url));
const assetNames = AVATAR_CATALOG.map((option) => option.assetPath.replace('./avatars/', ''));

function readGlb(name: string): Record<string, unknown> {
  const bytes = readFileSync(`${assetDir}${name}`);
  expect(bytes.subarray(0, 4).toString()).toBe('glTF');
  expect(bytes.readUInt32LE(4)).toBe(2);
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()) as Record<string, unknown>;
}

describe('avatar catalog generation', () => {
  it('keeps the generated Dart and TypeScript files in sync with avatar-catalog.json', () => {
    const script = fileURLToPath(new URL('../../scripts/generate-avatar-catalog.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
});

// The GLBs are gitignored; a fresh checkout runs ./scripts/fetch-assets.sh first.
describe('provisioned avatar assets', () => {
  for (const name of assetNames) {
    it.skipIf(!existsSync(`${assetDir}${name}`))(`has a TalkingHead-compatible ${name}`, () => {
      const json = readGlb(name);
      const nodes = (json.nodes as Array<{ name?: string }>) ?? [];
      const meshes = (json.meshes as Array<{ primitives?: Array<{ targets?: unknown[] }> }>) ?? [];
      const morphTargets = meshes.flatMap((mesh) => mesh.primitives ?? []).flatMap((primitive) => primitive.targets ?? []);
      expect(nodes.some((node) => node.name === 'Armature'), `${name} armature`).toBe(true);
      expect(nodes.some((node) => node.name === 'Head'), `${name} head`).toBe(true);
      expect(morphTargets.length, `${name} blendshapes`).toBeGreaterThan(0);
    });
  }
});
