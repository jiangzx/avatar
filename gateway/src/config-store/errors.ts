/** One reason a config change was refused. `message` is shown to the admin and never echoes config text. */
export interface ConfigIssue { key: string | null; message: string }

/** `cause` keeps the original loader error (a code, never config text) for startup crashes and tests. */
export class ConfigInvalidError extends Error {
  constructor(readonly issues: readonly ConfigIssue[], options?: { cause?: unknown }) {
    super('config_invalid', options);
  }
}

/** The draft was made against an older version; the admin must reload before changing again. */
export class ConfigConflictError extends Error {
  constructor(readonly activeVersion: number) {
    super('config_conflict');
  }
}
