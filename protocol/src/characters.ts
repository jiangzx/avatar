import { CHARACTER_IDS, DEFAULT_CHARACTER_ID } from './characters.generated.ts';

export { CHARACTER_IDS, DEFAULT_CHARACTER_ID };

/** One of the configured companion characters. The list lives in protocol/characters.json. */
export type CharacterId = (typeof CHARACTER_IDS)[number];

export function isCharacterId(v: unknown): v is CharacterId {
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v);
}
