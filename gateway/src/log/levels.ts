import { LEVEL_RANK, type LogLevel } from './logger.ts';

export interface LogLevelOverride { scope: 'global' | 'owner'; oid: string | null; level: LogLevel; until: number; actor: string }
export interface LogLevelControl {
  levelFor(oid: string | undefined): LogLevel; // most verbose of base, global and owner override; expired overrides ignored
  setOverride(override: LogLevelOverride): void;
  clearOverride(scope: 'global' | 'owner', oid: string | null): void;
  overrides(): readonly LogLevelOverride[]; // active only
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === '') return 'info';
  if ((LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new Error(`Unsupported LOG_LEVEL "${value}"`);
}

/** One instance per process, created in index.ts. Overrides live in memory and vanish on restart. */
export function createLogLevelControl(base: LogLevel, now: () => number = Date.now): LogLevelControl {
  const active = new Map<string, LogLevelOverride>();
  const key = (scope: 'global' | 'owner', oid: string | null) => (scope === 'global' ? 'global' : `owner:${oid}`);
  const live = (o: LogLevelOverride | undefined) => (o && o.until > now() ? o : undefined);
  return {
    levelFor(oid) {
      let level = base;
      for (const o of [live(active.get('global')), oid ? live(active.get(key('owner', oid))) : undefined]) {
        if (o && LEVEL_RANK[o.level] < LEVEL_RANK[level]) level = o.level;
      }
      return level;
    },
    setOverride(override) {
      if (override.scope === 'owner' && !override.oid) throw new Error('log_override_oid_required');
      active.set(key(override.scope, override.oid), { ...override });
    },
    clearOverride(scope, oid) {
      active.delete(key(scope, oid));
    },
    overrides() {
      for (const [k, o] of active) if (!live(o)) active.delete(k);
      return [...active.values()].map((o) => ({ ...o }));
    },
  };
}
