import type { CharacterId, Language } from '@anyidea/protocol';
import type { DirectorConfig } from './types.ts';

/** Role pack lookup rendered per character. Production: FileRoleCatalog (gateway/roles/); fixedRoleCatalog is the test stub. */
export interface RoleCatalog {
  defaultRole(): string;
  defaultLanguage(roleId: string): Language;
  supportedLanguages(roleId: string): readonly Language[];
  /** safety + persona + actions + activity directory, placeholders replaced for this character. */
  buildPersona(characterId: CharacterId, language?: Language): string;
  activityText(roleId: string, activityId: string, language?: Language): string | undefined;
  /** Director config with placeholders replaced for this character. */
  director(characterId: CharacterId, language?: Language): DirectorConfig;
  /** Shared extractor system prompt; it never names a character. */
  extractPrompt(language?: Language): string;
  /** Shared post-session reflection prompt; it never names a character. */
  reflectPrompt(language?: Language): string;
  /** Recall-phrasing system prompt for this character. */
  recallPrompt(characterId: CharacterId, language?: Language): string;
  /** Affect-analyzer system prompt for this character. */
  affectPrompt(characterId: CharacterId, language?: Language): string;
}

export const DEFAULT_ROLE = 'elder-companion';

/** Required languages this role does not ship; empty means the role is complete. */
export function missingRoleLanguages(
  roles: RoleCatalog,
  roleId: string,
  required: readonly Language[],
): Language[] {
  const supported = roles.supportedLanguages(roleId);
  return required.filter((language) => !supported.includes(language));
}

export interface FixedRoleCatalogOptions {
  languages?: readonly Language[];
  defaultLanguage?: Language;
  personas?: Partial<Record<Language, string>>;
  directors?: Partial<Record<Language, DirectorConfig>>;
}

/** Stub: every character shares one persona and Director config per language. */
export function fixedRoleCatalog(
  persona: string,
  director: DirectorConfig,
  options: FixedRoleCatalogOptions = {},
): RoleCatalog {
  const defaultLanguage = options.defaultLanguage ?? options.languages?.[0] ?? 'zh';
  // Keep the stub self-consistent: a declared default is always supported.
  const languages = options.languages === undefined
    ? [defaultLanguage]
    : options.languages.includes(defaultLanguage) ? options.languages : [defaultLanguage, ...options.languages];
  const personas = options.personas ?? {};
  const directors = options.directors ?? {};
  return {
    defaultRole: () => DEFAULT_ROLE,
    defaultLanguage: () => defaultLanguage,
    supportedLanguages: () => languages,
    buildPersona: (_characterId, language = defaultLanguage) => personas[language] ?? persona,
    activityText: () => undefined,
    director: (_characterId, language = defaultLanguage) => directors[language] ?? director,
    extractPrompt: () => 'FIXTURE EXTRACT',
    reflectPrompt: () => 'FIXTURE REFLECT',
    recallPrompt: () => 'FIXTURE RECALL',
    affectPrompt: () => 'FIXTURE AFFECT',
  };
}
