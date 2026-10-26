import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_CHARACTER_ID, LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import type { CharacterRegistry } from '../characters/registry.ts';
import { DirectorSchema } from '../config.ts';
import type { RoleCatalog } from './catalog.ts';
import { PROMPT_LABELS } from './labels.ts';
import type { DirectorConfig } from './types.ts';

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const LanguageSchema = z.enum(['zh', 'ja', 'en']);

const RoleSchema = z.object({
  id: Id,
  defaultLanguage: LanguageSchema,
  supportedLanguages: z.array(LanguageSchema).min(1),
  activities: z.array(Id).max(12),
}).strict();

const ActivitiesSchema = z.object({
  intro: z.string().min(1),
  activities: z.array(z.object({
    id: Id,
    title: z.string().min(1).max(20),
    summary: z.string().min(1).max(40),
  }).strict()).max(12),
}).strict();

const RoleDirectorSchema = DirectorSchema.extend({ topicInstruction: z.string().includes('{topic}') }).strict();
const TopicsSchema = z.array(z.object({
  id: Id,
  prompt: z.string().min(1).max(40),
  fallbackText: z.string().min(1).max(60),
}).strict()).min(1).max(50);

export interface SharedText { safety: string; actions: string; extract: string; recall: string; affect: string; care: string }
interface LoadedActivity { title: string; summary: string; text: string }
interface LoadedLanguage {
  /** persona.md with its placeholders still in place. */
  persona: string;
  activities: Map<string, LoadedActivity>;
  activityDirectory: string;
  director: DirectorConfig;
}
interface LoadedRole {
  defaultLanguage: Language;
  supportedLanguages: readonly Language[];
  languages: Map<Language, LoadedLanguage>;
}
/** One character in one language, placeholders replaced. Built at startup, immutable afterwards. */
interface RenderedPack { persona: string; director: DirectorConfig; recall: string; care: string; affect: string }

const TIMING_FIELDS = [
  'followupAfterMs', 'idleNoticeAfterMs', 'maxConsecutive', 'maxPerWindow', 'windowMs',
  'companyAfterMs', 'contextAfterMs', 'checkAfterMs', 'leaveAfterMs', 'checkinAfterMs',
  'restAfterMs', 'greetingRetryMs',
] as const;

/** The only placeholders a role pack may use; any other {{...}} left after rendering fails startup. */
const PLACEHOLDER = /\{\{(char|charSpoken|charIdentity)\}\}/g;

/** Role packs from gateway/roles/<role>/<language>/, rendered per character. Shared safety always comes first. */
export class FileRoleCatalog implements RoleCatalog {
  private constructor(
    private readonly roles: ReadonlyMap<string, LoadedRole>,
    private readonly shared: ReadonlyMap<Language, SharedText>,
    private readonly characterRoles: ReadonlyMap<CharacterId, string>,
    private readonly rendered: ReadonlyMap<CharacterId, ReadonlyMap<Language, RenderedPack>>,
    private readonly fallbackRole: string,
  ) {}

  static load(rootDir: string, characters: CharacterRegistry): FileRoleCatalog {
    const shared = loadShared(rootDir);
    const roles = new Map<string, LoadedRole>();
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const role = loadRole(join(rootDir, entry.name), entry.name);
      for (const language of role.supportedLanguages) {
        if (!shared.has(language)) throw new Error(`shared_missing:${language}:directory`);
      }
      roles.set(entry.name, role);
    }
    const characterRoles = new Map<CharacterId, string>();
    const rendered = new Map<CharacterId, Map<Language, RenderedPack>>();
    for (const characterId of characters.ids()) {
      const roleId = characters.roleOf(characterId);
      const role = roles.get(roleId);
      if (!role) throw new Error(`character_role_missing:${characterId}:${roleId}`);
      characterRoles.set(characterId, roleId);
      const packs = new Map<Language, RenderedPack>();
      for (const language of role.supportedLanguages) {
        packs.set(language, renderPack(characterId, language, role.languages.get(language)!, shared.get(language)!, characters));
      }
      rendered.set(characterId, packs);
    }
    return new FileRoleCatalog(roles, shared, characterRoles, rendered, characters.roleOf(DEFAULT_CHARACTER_ID));
  }

  defaultRole(): string { return this.fallbackRole; }
  defaultLanguage(roleId: string): Language { return this.role(roleId).defaultLanguage; }
  supportedLanguages(roleId: string): readonly Language[] { return this.role(roleId).supportedLanguages; }

  buildPersona(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).persona;
  }

  activityText(roleId: string, activityId: string, language = this.defaultLanguage(roleId)): string | undefined {
    return this.languagePack(roleId, language).activities.get(activityId)?.text;
  }

  director(characterId: CharacterId, language = this.characterLanguage(characterId)): DirectorConfig {
    return this.pack(characterId, language).director;
  }

  extractPrompt(language = this.defaultLanguage(this.fallbackRole)): string {
    return this.sharedFor(language).extract;
  }

  recallPrompt(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).recall;
  }

  carePrompt(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).care;
  }

  affectPrompt(characterId: CharacterId, language = this.characterLanguage(characterId)): string {
    return this.pack(characterId, language).affect;
  }

  /** Every rendered character × language, for startup budget and notice checks. */
  characterLanguagePairs(): Array<{ characterId: CharacterId; language: Language }> {
    return [...this.rendered.entries()].flatMap(([characterId, packs]) =>
      [...packs.keys()].map((language) => ({ characterId, language })),
    );
  }

  private characterLanguage(characterId: CharacterId): Language {
    return this.defaultLanguage(this.roleOfCharacter(characterId));
  }

  private roleOfCharacter(characterId: CharacterId): string {
    const roleId = this.characterRoles.get(characterId);
    if (!roleId) throw new Error(`unknown_character:${characterId}`);
    return roleId;
  }

  private pack(characterId: CharacterId, language: Language): RenderedPack {
    const pack = this.rendered.get(characterId)?.get(language);
    if (!pack) throw new Error(`language_unsupported:${this.roleOfCharacter(characterId)}:${language}`);
    return pack;
  }

  private role(roleId: string): LoadedRole {
    const role = this.roles.get(roleId);
    if (!role) throw new Error(`unknown_role:${roleId}`);
    return role;
  }

  private languagePack(roleId: string, language: Language): LoadedLanguage {
    const pack = this.role(roleId).languages.get(language);
    if (!pack) throw new Error(`language_unsupported:${roleId}:${language}`);
    return pack;
  }

  private sharedFor(language: Language): SharedText {
    const text = this.shared.get(language);
    if (!text) throw new Error(`shared_missing:${language}:directory`);
    return text;
  }
}

export function loadRoleCatalog(rootDir: string, characters: CharacterRegistry): FileRoleCatalog {
  return FileRoleCatalog.load(rootDir, characters);
}

function loadShared(rootDir: string): Map<Language, SharedText> {
  const shared = new Map<Language, SharedText>();
  for (const language of LANGUAGES) {
    const dir = join(rootDir, '_shared', language);
    if (!existsSync(dir)) continue;
    const read = (name: keyof SharedText): string => {
      const file = join(dir, `${name}.md`);
      if (!existsSync(file)) throw new Error(`shared_missing:${language}:${name}`);
      return readText(file);
    };
    const text: SharedText = {
      safety: read('safety'),
      actions: read('actions'),
      extract: read('extract'),
      recall: read('recall'),
      care: read('care'),
      affect: read('affect'),
    };
    // The extractor prompt is not rendered per character, so it must not carry placeholders.
    if (text.extract.includes('{{')) throw new Error(`placeholder_unresolved:shared:${language}:extract`);
    shared.set(language, text);
  }
  return shared;
}

function renderPack(
  characterId: CharacterId,
  language: Language,
  pack: LoadedLanguage,
  text: SharedText,
  characters: CharacterRegistry,
): RenderedPack {
  const values: Record<string, string> = {
    char: characters.name(characterId, language),
    charSpoken: characters.spokenName(characterId, language),
    charIdentity: characters.identity(characterId, language),
  };
  const render = (source: string, where: string): string => {
    // One pass: inserted values are never scanned again.
    const out = source.replace(PLACEHOLDER, (_match, key: string) => values[key]!);
    if (out.includes('{{')) throw new Error(`placeholder_unresolved:${characterId}:${language}:${where}`);
    return out;
  };
  return {
    persona: render([text.safety, pack.persona, text.actions, pack.activityDirectory].join('\n\n'), 'persona'),
    director: renderStrings(pack.director, (source) => render(source, 'director')),
    recall: render(text.recall, 'recall'),
    care: render(text.care, 'care'),
    affect: render(text.affect, 'affect'),
  };
}

/** Copies a JSON-like value and passes every string through `render`. */
function renderStrings<T>(value: T, render: (text: string) => string): T {
  if (typeof value === 'string') return render(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => renderStrings(item, render)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderStrings(item, render)])) as T;
  }
  return value;
}

function loadRole(dir: string, dirName: string): LoadedRole {
  const role = RoleSchema.parse(readJson(join(dir, 'role.json')));
  if (role.id !== dirName) throw new Error(`role_id_mismatch:${dirName}`);
  if (!role.supportedLanguages.includes(role.defaultLanguage)) throw new Error(`default_language_missing:${role.id}`);

  const languages = new Map<Language, LoadedLanguage>();
  for (const language of role.supportedLanguages) {
    const langDir = join(dir, language);
    if (!existsSync(langDir)) throw new Error(`language_missing:${role.id}:${language}`);
    const meta = ActivitiesSchema.parse(readJson(join(langDir, 'activities.json')));
    const metaIds = meta.activities.map((activity) => activity.id);
    if (metaIds.length !== role.activities.length || role.activities.some((id) => !metaIds.includes(id))) {
      throw new Error(`activity_set_mismatch:${role.id}:${language}`);
    }

    const personaFile = join(langDir, 'persona.md');
    if (!existsSync(personaFile)) throw new Error(`persona_missing:${role.id}:${language}`);
    const persona = readText(personaFile);
    if (!persona.includes('{{charIdentity}}')) throw new Error(`persona_identity_missing:${role.id}:${language}`);

    const activities = new Map<string, LoadedActivity>();
    for (const activity of meta.activities) {
      const file = join(langDir, 'activities', `${activity.id}.md`);
      if (!existsSync(file)) throw new Error(`activity_missing:${role.id}:${language}:${activity.id}`);
      const text = readText(file);
      // Activity texts are served as-is, so they must not carry placeholders.
      if (text.includes('{{')) throw new Error(`placeholder_unresolved:${role.id}:${language}:activity:${activity.id}`);
      activities.set(activity.id, { title: activity.title, summary: activity.summary, text });
    }

    const director = RoleDirectorSchema.parse(readJson(join(langDir, 'director.json')));
    const topics = TopicsSchema.parse(readJson(join(langDir, 'topics.json')));
    languages.set(language, {
      persona,
      activities,
      activityDirectory: [
        meta.intro,
        ...meta.activities.map((activity) => `- ${activity.title}${PROMPT_LABELS[language].separator}${activity.summary}`),
      ].join('\n'),
      director: { ...director, topics },
    });
  }
  validateTopics(role.id, languages);
  validateTimings(role.id, languages);
  validateCareTexts(role.id, languages);
  return {
    defaultLanguage: role.defaultLanguage,
    supportedLanguages: role.supportedLanguages,
    languages,
  };
}

/** Topic ids must match across languages; order may differ. */
function validateTopics(roleId: string, languages: Map<Language, LoadedLanguage>): void {
  const entries = [...languages.entries()];
  const first = entries[0];
  if (!first) return;
  const [firstLanguage, firstPack] = first;
  const reference = new Set(firstPack.director.topics?.map((topic) => topic.id) ?? []);
  for (const [language, pack] of entries) {
    if (language === firstLanguage) continue;
    const ids = new Set(pack.director.topics?.map((topic) => topic.id) ?? []);
    if (ids.size !== reference.size || [...ids].some((id) => !reference.has(id))) {
      throw new Error(`topic_set_mismatch:${roleId}`);
    }
  }
}

function validateTimings(roleId: string, languages: Map<Language, LoadedLanguage>): void {
  const entries = [...languages.entries()];
  const first = entries[0];
  if (!first) return;
  const [firstLanguage, firstPack] = first;
  for (const [language, pack] of entries) {
    if (language === firstLanguage) continue;
    for (const field of TIMING_FIELDS) {
      if (pack.director[field] !== firstPack.director[field]) {
        throw new Error(`language_timing_mismatch:${roleId}:${language}:${field}`);
      }
    }
  }
}

/** Care openings exist in every language or in none, so care never turns off silently for one language. */
function validateCareTexts(roleId: string, languages: Map<Language, LoadedLanguage>): void {
  const entries = [...languages.entries()];
  const has = ([, pack]: [Language, LoadedLanguage]) => (pack.director.greetingCareTexts?.length ?? 0) > 0;
  if (!entries.some(has)) return;
  const missing = entries.find((entry) => !has(entry));
  if (missing) throw new Error(`greeting_care_texts_mismatch:${roleId}:${missing[0]}`);
}

function readText(path: string): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_file:${path}`);
  return text;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
