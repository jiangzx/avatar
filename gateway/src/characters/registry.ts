import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHARACTER_IDS, type CharacterId, type Language } from '@anyidea/protocol';
import { CharacterCardSchema, hasForeignName, validateCard, type CharacterCard } from './card.ts';

export type VoiceAdapter = 'qwen' | 'seeduplex';

/** Read-only view of the character cards. Built once at startup; immutable afterwards. */
export interface CharacterRegistry {
  ids(): readonly CharacterId[];
  roleOf(id: CharacterId): string;
  gender(id: CharacterId): 'female' | 'male';
  name(id: CharacterId, language: Language): string;
  /** readings[lang] ?? name: the form TTS should speak. */
  spokenName(id: CharacterId, language: Language): string;
  identity(id: CharacterId, language: Language): string;
  greetingNoName(id: CharacterId, language: Language): string;
  greetingsFirstMeet(id: CharacterId, language: Language): readonly string[];
  /** undefined = the adapter's configured default voice. */
  voiceFor(id: CharacterId, adapter: VoiceAdapter, language: Language): string | undefined;
}

/** Loads gateway/characters/*.json. Any invalid card, or an id set other than CHARACTER_IDS, fails startup. */
export function loadCharacterRegistry(dir: string, supportedLanguages: readonly Language[]): CharacterRegistry {
  const cards = new Map<CharacterId, CharacterCard>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      throw new Error(`character_card_invalid_json:${file}`);
    }
    const parsed = CharacterCardSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`character_card_invalid:${file}:${parsed.error.issues.map((issue) => issue.path.join('.')).join(',')}`);
    }
    const card = parsed.data;
    if (file !== `${card.id}.json`) throw new Error(`character_id_mismatch:${file}`);
    validateCard(card, supportedLanguages);
    cards.set(card.id, card);
  }
  const missing = CHARACTER_IDS.filter((id) => !cards.has(id));
  if (missing.length > 0) throw new Error(`character_set_mismatch:${missing.join(',')}`);
  for (const card of cards.values()) {
    for (const other of cards.values()) {
      if (other.id !== card.id && hasForeignName(card, other)) throw new Error(`character_foreign_name:${card.id}:${other.id}`);
    }
  }
  return new CardRegistry(cards);
}

class CardRegistry implements CharacterRegistry {
  constructor(private readonly cards: ReadonlyMap<CharacterId, CharacterCard>) {}

  ids(): readonly CharacterId[] { return CHARACTER_IDS; }
  roleOf(id: CharacterId): string { return this.card(id).role; }
  gender(id: CharacterId): 'female' | 'male' { return this.card(id).gender; }
  name(id: CharacterId, language: Language): string { return pick(id, language, this.card(id).names[language]); }

  spokenName(id: CharacterId, language: Language): string {
    return this.card(id).readings?.[language] ?? this.name(id, language);
  }

  identity(id: CharacterId, language: Language): string { return pick(id, language, this.card(id).identity[language]); }
  greetingNoName(id: CharacterId, language: Language): string { return pick(id, language, this.card(id).greetingNoName[language]); }

  greetingsFirstMeet(id: CharacterId, language: Language): readonly string[] {
    return pick(id, language, this.card(id).greetingsFirstMeet[language]);
  }

  voiceFor(id: CharacterId, adapter: VoiceAdapter, language: Language): string | undefined {
    const voices = this.card(id).voices;
    if (adapter === 'qwen') return voices.qwen[language] ?? undefined;
    return language === 'ja' ? undefined : voices.seeduplex[language] ?? undefined;
  }

  private card(id: CharacterId): CharacterCard {
    const card = this.cards.get(id);
    if (!card) throw new Error(`unknown_character:${id}`);
    return card;
  }
}

function pick<T>(id: CharacterId, language: Language, value: T | undefined): T {
  if (value === undefined) throw new Error(`character_language_unsupported:${id}:${language}`);
  return value;
}
