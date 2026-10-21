import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { DirectorSchema } from '../config.ts';
import { DEFAULT_ROLE, type RoleCatalog } from './catalog.ts';
import { PROMPT_LABELS } from './labels.ts';
import type { DirectorConfig } from './types.ts';

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const LanguageSchema = z.enum(['zh', 'ja', 'en']);

const RoleSchema = z.object({
  id: Id,
  defaultStyle: Id,
  defaultLanguage: LanguageSchema,
  supportedLanguages: z.array(LanguageSchema).min(1),
  styles: z.array(Id).min(1),
  activities: z.array(Id).max(12),
  voices: z.object({
    zh: z.record(Id, z.string().min(1).max(64).nullable()).optional(),
    ja: z.record(Id, z.string().min(1).max(64).nullable()).optional(),
    en: z.record(Id, z.string().min(1).max(64).nullable()).optional(),
  }).strict().optional(),
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

export interface SharedText { safety: string; actions: string; extract: string; recall: string }
interface LoadedStyle { text: string; voice: string | undefined }
interface LoadedActivity { title: string; summary: string; text: string }
interface LoadedLanguage {
  styles: Map<string, LoadedStyle>;
  activities: Map<string, LoadedActivity>;
  activityDirectory: string;
  director: DirectorConfig;
}
interface LoadedRole {
  defaultStyle: string;
  defaultLanguage: Language;
  supportedLanguages: readonly Language[];
  languages: Map<Language, LoadedLanguage>;
}

const TIMING_FIELDS = [
  'followupAfterMs', 'idleNoticeAfterMs', 'maxConsecutive', 'maxPerWindow', 'windowMs',
  'companyAfterMs', 'contextAfterMs', 'checkAfterMs', 'leaveAfterMs', 'checkinAfterMs',
  'restAfterMs', 'greetingRetryMs',
] as const;

/** Roles from gateway/roles/<role>/<language>/; gateway/roles/_shared/<language>/ safety always comes first. */
export class FileRoleCatalog implements RoleCatalog {
  private constructor(
    private readonly shared: ReadonlyMap<Language, SharedText>,
    private readonly roles: ReadonlyMap<string, LoadedRole>,
    private readonly fallbackRole: string,
  ) {}

  static load(rootDir: string, defaultRoleId: string = DEFAULT_ROLE): FileRoleCatalog {
    const shared = new Map<Language, SharedText>();
    for (const language of LANGUAGES) {
      const dir = join(rootDir, '_shared', language);
      if (!existsSync(dir)) continue;
      const readShared = (name: keyof SharedText): string => {
        const file = join(dir, `${name}.md`);
        if (!existsSync(file)) throw new Error(`shared_missing:${language}:${name}`);
        return readText(file);
      };
      shared.set(language, {
        safety: readShared('safety'),
        actions: readShared('actions'),
        extract: readShared('extract'),
        recall: readShared('recall'),
      });
    }
    const roles = new Map<string, LoadedRole>();
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const role = loadRole(join(rootDir, entry.name), entry.name);
      for (const language of role.supportedLanguages) {
        if (!shared.has(language)) throw new Error(`shared_missing:${language}`);
      }
      roles.set(entry.name, role);
    }
    if (!roles.has(defaultRoleId)) throw new Error(`role_missing:${defaultRoleId}`);
    return new FileRoleCatalog(shared, roles, defaultRoleId);
  }

  defaultRole(): string { return this.fallbackRole; }
  defaultLanguage(roleId: string): Language { return this.role(roleId).defaultLanguage; }
  supportedLanguages(roleId: string): readonly Language[] { return this.role(roleId).supportedLanguages; }
  defaultStyle(roleId: string): string { return this.role(roleId).defaultStyle; }

  hasStyle(roleId: string, styleId: string): boolean {
    const role = this.roles.get(roleId);
    if (!role) return false;
    return role.supportedLanguages.every((language) => role.languages.get(language)!.styles.has(styleId));
  }

  voiceFor(roleId: string, styleId: string, language = this.defaultLanguage(roleId)): string | undefined {
    return this.languagePack(roleId, language).styles.get(styleId)?.voice;
  }

  buildPersona(roleId: string, styleId: string, language = this.defaultLanguage(roleId)): string {
    const pack = this.languagePack(roleId, language);
    const shared = this.sharedFor(language);
    const style = pack.styles.get(styleId);
    if (!style) throw new Error(`unknown_style:${roleId}/${styleId}`);
    return [shared.safety, style.text, shared.actions, pack.activityDirectory].join('\n\n');
  }

  activityText(roleId: string, activityId: string, language = this.defaultLanguage(roleId)): string | undefined {
    return this.languagePack(roleId, language).activities.get(activityId)?.text;
  }

  director(roleId: string, language = this.defaultLanguage(roleId)): DirectorConfig {
    return this.languagePack(roleId, language).director;
  }

  extractPrompt(language = this.defaultLanguage(this.fallbackRole)): string {
    return this.sharedFor(language).extract;
  }

  recallPrompt(language = this.defaultLanguage(this.fallbackRole)): string {
    return this.sharedFor(language).recall;
  }

  pairs(): Array<{ roleId: string; styleId: string }> {
    return [...this.roles.entries()].flatMap(([roleId, role]) => {
      const styleIds = [...role.languages.get(role.defaultLanguage)!.styles.keys()];
      return styleIds.map((styleId) => ({ roleId, styleId }));
    });
  }

  languagePairs(): Array<{ roleId: string; styleId: string; language: Language }> {
    return [...this.roles.entries()].flatMap(([roleId, role]) =>
      role.supportedLanguages.flatMap((language) =>
        [...role.languages.get(language)!.styles.keys()].map((styleId) => ({ roleId, styleId, language })),
      ),
    );
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
    if (!text) throw new Error(`shared_missing:${language}`);
    return text;
  }
}

export function loadRoleCatalog(rootDir: string, defaultRoleId?: string): FileRoleCatalog {
  return FileRoleCatalog.load(rootDir, defaultRoleId);
}

function loadRole(dir: string, dirName: string): LoadedRole {
  const role = RoleSchema.parse(readJson(join(dir, 'role.json')));
  if (role.id !== dirName) throw new Error(`role_id_mismatch:${dirName}`);
  if (!role.styles.includes(role.defaultStyle)) throw new Error(`default_style_missing:${role.id}`);
  if (!role.supportedLanguages.includes(role.defaultLanguage)) throw new Error(`default_language_missing:${role.id}`);
  for (const [language, voices] of Object.entries(role.voices ?? {})) {
    if (!role.supportedLanguages.includes(language as Language)) throw new Error(`voice_language_mismatch:${role.id}:${language}`);
    for (const styleId of Object.keys(voices)) {
      if (!role.styles.includes(styleId)) throw new Error(`voice_style_mismatch:${role.id}:${styleId}`);
    }
  }

  const languages = new Map<Language, LoadedLanguage>();
  for (const language of role.supportedLanguages) {
    const langDir = join(dir, language);
    if (!existsSync(langDir)) throw new Error(`language_missing:${role.id}:${language}`);
    const meta = ActivitiesSchema.parse(readJson(join(langDir, 'activities.json')));
    const metaIds = meta.activities.map((activity) => activity.id);
    if (metaIds.length !== role.activities.length || role.activities.some((id) => !metaIds.includes(id))) {
      throw new Error(`activity_set_mismatch:${role.id}:${language}`);
    }

    const styles = new Map<string, LoadedStyle>();
    for (const styleId of role.styles) {
      const file = join(langDir, 'styles', `${styleId}.md`);
      if (!existsSync(file)) throw new Error(`style_missing:${role.id}:${language}:${styleId}`);
      styles.set(styleId, { text: readText(file), voice: role.voices?.[language]?.[styleId] ?? undefined });
    }

    const activities = new Map<string, LoadedActivity>();
    for (const activity of meta.activities) {
      const file = join(langDir, 'activities', `${activity.id}.md`);
      if (!existsSync(file)) throw new Error(`activity_missing:${role.id}:${language}:${activity.id}`);
      activities.set(activity.id, { title: activity.title, summary: activity.summary, text: readText(file) });
    }

    const director = RoleDirectorSchema.parse(readJson(join(langDir, 'director.json')));
    const topics = TopicsSchema.parse(readJson(join(langDir, 'topics.json')));
    languages.set(language, {
      styles,
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
  return {
    defaultStyle: role.defaultStyle,
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

function readText(path: string): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_file:${path}`);
  return text;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
