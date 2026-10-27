import { describe, expect, it } from 'vitest';
import { createLogLevelControl, parseLogLevel } from '../src/log/levels.ts';

describe('parseLogLevel', () => {
  it('defaults to info and accepts the four levels', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    for (const level of ['debug', 'info', 'warn', 'error'] as const) expect(parseLogLevel(level)).toBe(level);
  });
  it('rejects anything else', () => {
    expect(() => parseLogLevel('verbose')).toThrow('Unsupported LOG_LEVEL "verbose"');
  });
});

describe('createLogLevelControl', () => {
  it('uses the base level without overrides', () => {
    const levels = createLogLevelControl('warn', () => 0);
    expect(levels.levelFor(undefined)).toBe('warn');
    expect(levels.levelFor('abc')).toBe('warn');
    expect(levels.overrides()).toEqual([]);
  });

  it('applies the most verbose of base, global and owner overrides until they expire', () => {
    let now = 1_000;
    const levels = createLogLevelControl('info', () => now);
    levels.setOverride({ scope: 'owner', oid: 'o1', level: 'debug', until: 2_000, actor: 'admin' });
    expect(levels.levelFor('o1')).toBe('debug');
    expect(levels.levelFor('o2')).toBe('info');
    expect(levels.levelFor(undefined)).toBe('info');
    levels.setOverride({ scope: 'global', oid: null, level: 'warn', until: 3_000, actor: 'admin' });
    expect(levels.levelFor('o2')).toBe('info'); // a quieter global override never hides the base level
    now = 2_000;
    expect(levels.levelFor('o1')).toBe('info');
    expect(levels.overrides().map((o) => o.scope)).toEqual(['global']);
  });

  it('replaces an override of the same scope and clears it on request', () => {
    const levels = createLogLevelControl('info', () => 0);
    levels.setOverride({ scope: 'global', oid: null, level: 'debug', until: 10, actor: 'a' });
    levels.setOverride({ scope: 'global', oid: null, level: 'warn', until: 20, actor: 'b' });
    expect(levels.overrides()).toEqual([{ scope: 'global', oid: null, level: 'warn', until: 20, actor: 'b' }]);
    levels.clearOverride('global', null);
    expect(levels.overrides()).toEqual([]);
  });

  it('requires an oid for owner overrides', () => {
    const levels = createLogLevelControl('info', () => 0);
    expect(() => levels.setOverride({ scope: 'owner', oid: null, level: 'debug', until: 10, actor: 'a' })).toThrow('log_override_oid_required');
  });
});
