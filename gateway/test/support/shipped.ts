import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '@anyidea/protocol';
import { loadCharacterRegistry, type CharacterRegistry } from '../../src/characters/registry.ts';
import { loadRoleCatalog, type FileRoleCatalog } from '../../src/roles/fileCatalog.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The shipped cards in gateway/characters/. */
export function shippedCharacters(): CharacterRegistry {
  return loadCharacterRegistry(`${root}characters`, LANGUAGES);
}

/** The shipped role packs rendered for the shipped cards. */
export function shippedRoles(): FileRoleCatalog {
  return loadRoleCatalog(`${root}roles`, shippedCharacters());
}

/** test/fixtures/characters: the three ids on role test-role, zh and ja only. */
export function fixtureCharacters(): CharacterRegistry {
  return loadCharacterRegistry(`${root}test/fixtures/characters`, ['zh', 'ja']);
}
