import type { Language } from '@anyidea/protocol';
import type { DirectorConfig } from './types.ts';

/** Role and style lookup. Production: FileRoleCatalog (gateway/roles/); fixedRoleCatalog is the test stub. */
export interface RoleCatalog {
  defaultRole(): string;
  defaultLanguage(roleId: string): Language;
  supportedLanguages(roleId: string): readonly Language[];
  defaultStyle(roleId: string): string;
  hasStyle(roleId: string, styleId: string): boolean;
  /** undefined = the adapter's configured default voice for this language. */
  voiceFor(roleId: string, styleId: string, language?: Language): string | undefined;
  buildPersona(roleId: string, styleId: string, language?: Language): string;
  activityText(roleId: string, activityId: string, language?: Language): string | undefined;
  director(roleId: string, language?: Language): DirectorConfig;
  pairs(): Array<{ roleId: string; styleId: string }>;
}

export const DEFAULT_ROLE = 'elder-companion';
const STUB_STYLES: readonly string[] = ['grandchild', 'old-friend'];

export interface FixedRoleCatalogOptions {
  languages?: readonly Language[];
  defaultLanguage?: Language;
  personas?: Partial<Record<Language, string>>;
  directors?: Partial<Record<Language, DirectorConfig>>;
}

/** Stub: every style of the default role shares one persona and Director config per language. */
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
    defaultStyle: () => 'grandchild',
    hasStyle: (roleId, styleId) => roleId === DEFAULT_ROLE && STUB_STYLES.includes(styleId),
    voiceFor: () => undefined,
    buildPersona: (_roleId, _styleId, language = defaultLanguage) => personas[language] ?? persona,
    activityText: () => undefined,
    director: (_roleId, language = defaultLanguage) => directors[language] ?? director,
    pairs: () => STUB_STYLES.map((styleId) => ({ roleId: DEFAULT_ROLE, styleId })),
  };
}
