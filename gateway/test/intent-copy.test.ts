import { LANGUAGES } from '@anyidea/protocol';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import * as configModule from '../src/config.ts';
import { loadDirectorConfig } from '../src/config.ts';
import { ConfigInvalidError } from '../src/config-store/errors.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { containsPhrase } from '../src/i18n/text.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { FALLBACK_KEYS, INTENT_PURPOSES } from '../src/roles/types.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const zhPath = `${root}roles/elder-companion/zh/director.json`;
const raw = () => JSON.parse(readFileSync(zhPath, 'utf8')) as Record<string, any>;
const models = { realtimeEndpoint: '', realtimeModel: 'm', textEndpoint: '', summarizerModel: 'm' };
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6_000 };
const i18n = loadI18n(`${root}config`);

describe('zh intent copy', () => {
  const zh = loadDirectorConfig(zhPath);

  it('has every purpose and the plan-A fragments', () => {
    expect(Object.keys(zh.intents!.purposes).sort()).toEqual([...INTENT_PURPOSES].sort());
    expect(zh.intents!.frame).toContain('{maxChars}');
    expect(zh.intents!.frame).toContain('{purpose}');
    expect(zh.intents!.withQuote).toContain('{said}');
    expect(zh.intents!.withQuote).toContain('{material}');
    expect(zh.intents!.withTopic).toContain('{material}');
    expect(zh.intents!.speakLine).toContain('{line}');
    expect(zh.intents!.saidWhen.days).toHaveLength(5);
  });

  it('has at least five distinct fallback lines per key', () => {
    expect(Object.keys(zh.fallbacks!).sort()).toEqual([...FALLBACK_KEYS].sort());
    for (const key of FALLBACK_KEYS) {
      const lines = zh.fallbacks![key];
      expect(lines.length, key).toBeGreaterThanOrEqual(5);
      expect(new Set(lines).size, key).toBe(lines.length);
    }
  });

  it('keeps fallback lines free of quotes, names, questions where banned, and medical advice', () => {
    const health = i18n.memory.zh.healthWords;
    for (const key of FALLBACK_KEYS) {
      for (const line of zh.fallbacks![key]) {
        expect(line, key).not.toMatch(/[{}《》「」]/);
        expect([...line].length, key).toBeLessThanOrEqual(30);
        // No group may carry a health word: no pills, no hospital, no symptoms.
        expect(health.filter((word) => containsPhrase(line, word)), `${key}: ${line}`).toEqual([]);
      }
    }
    for (const line of zh.fallbacks!.restQuiet) expect(line).not.toMatch(/[？?]/);
    const rules = i18n.silence.zh;
    for (const line of zh.fallbacks!.presenceCheck) {
      expect(rules.listening.some((w) => containsPhrase(line, w)), line).toBe(true);
      expect(rules.anytime.some((w) => containsPhrase(line, w)), line).toBe(true);
    }
  });

  it('requires intents and fallbacks together, five lines minimum', () => {
    // DirectorSchema stays a ZodObject so RoleDirectorSchema can .extend it; the pair check is a refine.
    const { DirectorSchema, checkIntentPair } = configModule;
    const parse = (value: unknown) => DirectorSchema.refine(checkIntentPair).safeParse(value);
    const onlyIntents = raw();
    delete onlyIntents.fallbacks;
    expect(parse(onlyIntents).success).toBe(false);
    const short = raw();
    short.fallbacks.routine = short.fallbacks.routine.slice(0, 4);
    expect(parse(short).success).toBe(false);
    const missingPurpose = raw();
    delete missingPurpose.intents.purposes.selfShare;
    expect(parse(missingPurpose).success).toBe(false);
    const neither = raw();
    delete neither.intents;
    delete neither.fallbacks;
    expect(parse(neither).success).toBe(true);
  });

  it('ships intents only in zh (Q21) and renders {{char}} inside them', () => {
    const roles = loadRoleCatalog(`${root}roles`, loadCharacterRegistry(`${root}characters`, LANGUAGES));
    expect(roles.director('xiaonuan', 'zh').intents).toBeDefined();
    expect(roles.director('xiaonuan', 'ja').intents).toBeUndefined();
    expect(roles.director('xiaonuan', 'en').fallbacks).toBeUndefined();
    expect(JSON.stringify(roles.director('xiaonuan', 'zh').intents)).not.toContain('{{');
  });
});

describe('fallbackAfterMs cross-check', () => {
  it('rejects a fallback wait longer than the shortest silence step', () => {
    expect(() => buildConfigSnapshot({ gatewayRoot: root, overlay: {}, version: 1, ledger, sessionStartTimeoutMs: 10_000, models })).not.toThrow();
    try {
      buildConfigSnapshot({
        gatewayRoot: root,
        overlay: { 'role:elder-companion/*/director.contextAfterMs': 3_000, 'proactivity:fallbackAfterMs': 3_500 },
        version: 2, ledger, sessionStartTimeoutMs: 10_000, models,
      });
      expect.fail('expected ConfigInvalidError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as ConfigInvalidError).issues.map((issue) => issue.message).join('\n')).toMatch(/兜底/);
    }
    // The admin minimum for the first silence step (3 s) still passes with the shipped 3 s fallback wait.
    expect(() => buildConfigSnapshot({
      gatewayRoot: root,
      overlay: { 'role:elder-companion/*/director.contextAfterMs': 3_000 },
      version: 3, ledger, sessionStartTimeoutMs: 10_000, models,
    })).not.toThrow();
  });
});
