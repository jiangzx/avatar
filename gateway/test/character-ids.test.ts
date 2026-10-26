import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, DEFAULT_CHARACTER_ID } from '@anyidea/protocol';

const repo = fileURLToPath(new URL('../../', import.meta.url));

describe('generated character ids', () => {
  it('are in sync with protocol/characters.json (generator --check)', () => {
    const result = spawnSync(process.execPath, [`${repo}scripts/generate-character-ids.mjs`, '--check'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('character ids are up to date');
  });

  it('give the gateway the same list and default as the json source', () => {
    const source = JSON.parse(readFileSync(`${repo}protocol/characters.json`, 'utf8')) as { ids: string[]; defaultId: string };
    expect([...CHARACTER_IDS]).toEqual(source.ids);
    expect(DEFAULT_CHARACTER_ID).toBe(source.defaultId);
    const dart = readFileSync(`${repo}app/lib/identity/character_ids.generated.dart`, 'utf8');
    expect(dart).toContain(`const characterIds = <String>[${source.ids.map((id) => `'${id}'`).join(', ')}];`);
    expect(dart).toContain(`const defaultCharacterId = '${source.defaultId}';`);
  });
});
