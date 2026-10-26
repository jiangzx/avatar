import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadMockScript, withCharacterName } from '../src/adapters/mock.ts';
import { shippedCharacters } from './support/shipped.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Names of the retired avatars must not come back either. */
const RETIRED = ['Lily', '小柔'];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((relative) => join(dir, relative))
    .filter((path) => statSync(path).isFile());
}

describe('character names stay out of shared prompts', () => {
  it('has no literal character name in gateway/roles/** or the Mock script', () => {
    const characters = shippedCharacters();
    const names = new Set([
      ...RETIRED,
      ...CHARACTER_IDS.flatMap((id) => LANGUAGES.flatMap((language) => [characters.name(id, language), characters.spokenName(id, language)])),
    ]);
    const files = [...filesUnder(join(root, 'roles')), join(root, 'mock', 'script.json')];
    expect(files.length).toBeGreaterThan(40);
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...names].filter((name) => text.includes(name)).map((name) => `${file.slice(root.length)}:${name}`);
    });
    expect(hits).toEqual([]);
  });

  it('fills the session character into the Mock greeting', () => {
    const script = loadMockScript(join(root, 'mock', 'script.json'));
    expect(script.greeting).toContain('{{char}}');
    const filled = withCharacterName(script, shippedCharacters().name('xiaokai', 'zh'));
    expect(filled.greeting).toContain('小凯');
    expect(filled.greeting).not.toContain('{{');
  });
});
