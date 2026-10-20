import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '@anyidea/protocol';
import { z } from 'zod';
import { DirectorSchema } from '../config.ts';
import { DEFAULT_ROLE, type RoleCatalog } from './catalog.ts';
import type { DirectorConfig } from './types.ts';

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
/** Relative markdown path inside the role directory; no "..", no absolute paths. */
const RelPath = z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*\.md$/);

const RoleSchema = z.object({
  id: Id,
  defaultStyle: Id,
  styles: z.record(Id, z.object({ file: RelPath, voice: z.string().min(1).max(64).nullable() }).strict()),
  activityIntro: z.string().min(1),
  activities: z.array(z.object({ id: Id, title: z.string().min(1).max(20), summary: z.string().min(1).max(40), file: RelPath }).strict()).max(12),
}).strict();

const RoleDirectorSchema = DirectorSchema.extend({ topicInstruction: z.string().includes('{topic}') }).strict();
const TopicsSchema = z.array(z.object({ id: Id, prompt: z.string().min(1).max(40), fallbackText: z.string().min(1).max(60) }).strict()).min(1).max(50);

interface LoadedStyle { text: string; voice: string | undefined }
interface LoadedRole {
  defaultStyle: string;
  styles: Map<string, LoadedStyle>;
  activityDirectory: string;
  activityTexts: Map<string, string>;
  director: DirectorConfig;
}

/** Roles from gateway/roles/<id>/; gateway/roles/_shared/safety.md always comes first and cannot be overridden. */
export class FileRoleCatalog implements RoleCatalog {
  private constructor(
    private readonly safety: string,
    private readonly actions: string,
    private readonly roles: ReadonlyMap<string, LoadedRole>,
    private readonly fallbackRole: string,
  ) {}

  static load(rootDir: string, defaultRoleId: string = DEFAULT_ROLE): FileRoleCatalog {
    const safety = readText(join(rootDir, '_shared', 'safety.md'));
    const actions = readText(join(rootDir, '_shared', 'actions.md'));
    const roles = new Map<string, LoadedRole>();
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      roles.set(entry.name, loadRole(join(rootDir, entry.name), entry.name));
    }
    if (!roles.has(defaultRoleId)) throw new Error(`role_missing:${defaultRoleId}`);
    return new FileRoleCatalog(safety, actions, roles, defaultRoleId);
  }

  defaultRole(): string { return this.fallbackRole; }
  defaultLanguage(roleId: string): Language { this.role(roleId); return 'zh'; }
  supportedLanguages(roleId: string): readonly Language[] { this.role(roleId); return ['zh']; }
  defaultStyle(roleId: string): string { return this.role(roleId).defaultStyle; }
  hasStyle(roleId: string, styleId: string): boolean { return this.roles.get(roleId)?.styles.has(styleId) ?? false; }
  voiceFor(roleId: string, styleId: string, _language: Language = 'zh'): string | undefined {
    return this.style(roleId, styleId).voice;
  }
  director(roleId: string, _language: Language = 'zh'): DirectorConfig { return this.role(roleId).director; }

  buildPersona(roleId: string, styleId: string, _language: Language = 'zh'): string {
    return [this.safety, this.style(roleId, styleId).text, this.actions, this.role(roleId).activityDirectory].join('\n\n');
  }

  /** Full activity card text (loaded on demand by a later start_activity tool). */
  activityText(roleId: string, activityId: string, _language: Language = 'zh'): string | undefined {
    return this.roles.get(roleId)?.activityTexts.get(activityId);
  }

  /** Every role/style combination, for startup budget checks. */
  pairs(): Array<{ roleId: string; styleId: string }> {
    return [...this.roles.entries()].flatMap(([roleId, r]) => [...r.styles.keys()].map((styleId) => ({ roleId, styleId })));
  }

  /** Every role/style/language combination; zh until roles are split into language directories (M1). */
  languagePairs(): Array<{ roleId: string; styleId: string; language: Language }> {
    return this.pairs().map((pair) => ({ ...pair, language: 'zh' }));
  }

  private role(roleId: string): LoadedRole {
    const r = this.roles.get(roleId);
    if (!r) throw new Error(`unknown_role:${roleId}`);
    return r;
  }

  private style(roleId: string, styleId: string): LoadedStyle {
    const s = this.role(roleId).styles.get(styleId);
    if (!s) throw new Error(`unknown_style:${roleId}/${styleId}`);
    return s;
  }
}

export function loadRoleCatalog(rootDir: string, defaultRoleId?: string): FileRoleCatalog {
  return FileRoleCatalog.load(rootDir, defaultRoleId);
}

function loadRole(dir: string, dirName: string): LoadedRole {
  const role = RoleSchema.parse(readJson(join(dir, 'role.json')));
  if (role.id !== dirName) throw new Error(`role_id_mismatch:${dirName}`);
  if (!(role.defaultStyle in role.styles)) throw new Error(`default_style_missing:${role.id}`);
  const styles = new Map<string, LoadedStyle>(
    Object.entries(role.styles).map(([id, s]) => [id, { text: readText(join(dir, s.file)), voice: s.voice ?? undefined }]),
  );
  const activityTexts = new Map(role.activities.map((a) => [a.id, readText(join(dir, a.file))]));
  const activityDirectory = [role.activityIntro, ...role.activities.map((a) => `- ${a.title}：${a.summary}`)].join('\n');
  const topics = TopicsSchema.parse(readJson(join(dir, 'topics.json')));
  const director: DirectorConfig = { ...RoleDirectorSchema.parse(readJson(join(dir, 'director.json'))), topics };
  return { defaultStyle: role.defaultStyle, styles, activityDirectory, activityTexts, director };
}

function readText(path: string): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_file:${path}`);
  return text;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
