import { z } from 'zod';
import { CHARACTER_IDS, type Language } from '@anyidea/protocol';

/** First-meet templates are spoken whole. Counted in characters, without the {name} token. */
export const FIRST_MEET_MAX_CHARS: Readonly<Record<Language, number>> = { zh: 40, ja: 50, en: 100 };

const RoleId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const Name = z.string().trim().min(1).max(20);
const Voice = z.string().min(1).max(64).nullable();
const perLanguage = <T extends z.ZodType>(value: T) =>
  z.object({ zh: value.optional(), ja: value.optional(), en: value.optional() }).strict();

/** gateway/characters/<id>.json, modeled on Character Card V2. Characters are ours only; users cannot edit them. */
export const CharacterCardSchema = z.object({
  id: z.enum(CHARACTER_IDS),
  /** Role pack that provides the shared rules. */
  role: RoleId,
  gender: z.enum(['female', 'male']),
  names: perLanguage(Name),
  /** Spoken form for TTS, e.g. katakana for ja. */
  readings: perLanguage(Name).optional(),
  /** Relationship and personality, inserted into persona.md as {{charIdentity}}. */
  identity: perLanguage(z.string().trim().min(1).max(400)),
  greetingNoName: perLanguage(z.string().trim().min(1).max(120)),
  greetingsFirstMeet: perLanguage(z.array(z.string().trim().min(1).max(200)).min(1).max(5)),
  voices: z.object({
    qwen: z.object({ zh: Voice, ja: Voice, en: Voice }).strict(),
    // Seeduplex has no Japanese voice.
    seeduplex: z.object({ zh: Voice, en: Voice }).strict(),
  }).strict(),
  /** Namespaced keys only, e.g. "avatar/duixModel". */
  extensions: z.record(z.string().regex(/^[a-z][a-z0-9-]*\/[A-Za-z0-9-]+$/), z.unknown()),
}).strict();

export type CharacterCard = z.infer<typeof CharacterCardSchema>;

const PER_LANGUAGE_FIELDS = ['names', 'identity', 'greetingNoName', 'greetingsFirstMeet'] as const;

/** Per-card rules that zod cannot express: language coverage and first-meet templates. */
export function validateCard(card: CharacterCard, supportedLanguages: readonly Language[]): void {
  for (const language of supportedLanguages) {
    for (const field of PER_LANGUAGE_FIELDS) {
      if (card[field][language] === undefined) throw new Error(`character_language_missing:${card.id}:${language}:${field}`);
    }
    card.greetingsFirstMeet[language]!.forEach((text, index) => {
      const length = Array.from(text.replaceAll('{name}', '')).length;
      if (!text.includes('{name}') || length > FIRST_MEET_MAX_CHARS[language]) {
        throw new Error(`character_first_meet_invalid:${card.id}:${language}:${index}`);
      }
    });
  }
}

/** True when any name or reading of `other` appears in `card`'s identity or opening lines (Q14). */
export function hasForeignName(card: CharacterCard, other: CharacterCard): boolean {
  const names = [...Object.values(other.names), ...Object.values(other.readings ?? {})]
    .filter((value): value is string => typeof value === 'string');
  const texts = [
    ...Object.values(card.identity),
    ...Object.values(card.greetingNoName),
    ...Object.values(card.greetingsFirstMeet).flat(),
  ].filter((value): value is string => typeof value === 'string');
  return names.some((name) => texts.some((text) => text.includes(name)));
}
