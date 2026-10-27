import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));

describe('usage scope', () => {
  it('eval code and scripts never wire a usage recorder', () => {
    for (const file of [...files('src/eval'), ...files('scripts')]) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).not.toMatch(/SqliteUsageRecorder|recorder\s*:|usageSource\s*:/);
    }
  });

  it('only index.ts constructs the recorder', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (rel.endsWith('.ts') && readFileSync(join(root, rel), 'utf8').includes('new SqliteUsageRecorder(')) offenders.push(rel);
      }
    };
    walk('src');
    expect(offenders).toEqual(['src/index.ts']);
  });
});
