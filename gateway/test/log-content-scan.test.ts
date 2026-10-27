import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_FIELD_NAMES, BANNED_FIELD_WORDS } from '../src/log/fieldGuard.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const CALL = /\.(?:debug|info|warn|error)\(\s*'([^']+)'\s*(?:,\s*\{([^{}]*)\})?/g;
const EVENT = /^[a-z][a-z0-9_]{0,63}$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Literal keys of `{ a, b: 1, ...rest }`; spreads are checked at runtime by the strict test logger. */
function keysOf(body: string): string[] {
  return body.split(',').map((part) => part.trim()).filter((part) => part && !part.startsWith('...'))
    .map((part) => part.split(':')[0]!.trim()).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
}

const calls = files(SRC).flatMap((path) => [...readFileSync(path, 'utf8').matchAll(CALL)].map((m) => ({
  file: relative(SRC, path), event: m[1]!, keys: m[2] ? keysOf(m[2]) : [],
})));

describe('log calls in gateway/src', () => {
  it('finds the migrated call sites', () => {
    expect(calls.length).toBeGreaterThanOrEqual(90);
  });

  it('use valid event names', () => {
    expect(calls.filter((c) => !EVENT.test(c.event))).toEqual([]);
  });

  it('never use a content-like field name outside the allowlist', () => {
    const bad = calls.flatMap((c) => c.keys
      .filter((key) => !ALLOWED_FIELD_NAMES.has(key) && BANNED_FIELD_WORDS.some((word) => key.toLowerCase().includes(word)))
      .map((key) => `${c.file}:${c.event}:${key}`));
    expect(bad).toEqual([]);
  });

  it('no longer import the legacy log module', () => {
    const legacy = files(SRC).filter((path) => /from '(\.\.\/)+log\.ts'|from '\.\/log\.ts'/.test(readFileSync(path, 'utf8')));
    expect(legacy.map((path) => relative(SRC, path))).toEqual([]);
  });
});
