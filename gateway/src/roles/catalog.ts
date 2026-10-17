import type { DirectorConfig } from './types.ts';

/** Role and style lookup. Production: FileRoleCatalog (gateway/roles/); fixedRoleCatalog is the test stub. */
export interface RoleCatalog {
  defaultRole(): string;
  defaultStyle(roleId: string): string;
  hasStyle(roleId: string, styleId: string): boolean;
  /** undefined = the adapter's configured default voice. */
  voiceFor(roleId: string, styleId: string): string | undefined;
  buildPersona(roleId: string, styleId: string): string;
  director(roleId: string): DirectorConfig;
}

export const DEFAULT_ROLE = 'elder-companion';
const STUB_STYLES: readonly string[] = ['grandchild', 'old-friend'];

/** Stub: every style of the default role shares one persona and Director config. */
export function fixedRoleCatalog(persona: string, director: DirectorConfig): RoleCatalog {
  return {
    defaultRole: () => DEFAULT_ROLE,
    defaultStyle: () => 'grandchild',
    hasStyle: (roleId, styleId) => roleId === DEFAULT_ROLE && STUB_STYLES.includes(styleId),
    voiceFor: () => undefined,
    buildPersona: () => persona,
    director: () => director,
  };
}
