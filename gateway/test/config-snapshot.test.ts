import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadConfig } from '../src/config.ts';
import { extractPlaceholders, loadDescriptorCatalog, type ConcreteItem } from '../src/config-store/descriptors.ts';
import { ConfigInvalidError } from '../src/config-store/errors.ts';
import { parseOverlayKey, readTargetValue, type ModelDefaults, type Overlay, type OverlayValue } from '../src/config-store/keys.ts';
import { loadAdminOptions } from '../src/config-store/options.ts';
import { toStored } from '../src/config-store/units.ts';
import { validateDisplayValue } from '../src/config-store/validate.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { I18nBundle } from '../src/i18n/types.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';
import { loadMemoryBudget, loadPacing } from '../src/session/pacing.ts';
import { shippedRoles } from './support/shipped.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const adminOptions = loadAdminOptions(root);
const adminModels = adminOptions.realtimeModels.map((option) => option.value);
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/api-ws/v1/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/compatible-mode/v1/chat/completions',
  summarizerModel: 'qwen-flash',
};
const tmpRoot = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function build(overlay: Overlay, version = 1) {
  return buildConfigSnapshot({
    gatewayRoot: root, overlay, version, ledger: env.ledger,
    sessionStartTimeoutMs: env.sessionStartTimeoutMs, models, voiceDefaults: env.qwenVoices, tmpRoot,
  });
}

function issuesOf(overlay: Overlay): string[] {
  try {
    build(overlay);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigInvalidError);
    return (error as ConfigInvalidError).issues.map((issue) => issue.message);
  }
  throw new Error('expected ConfigInvalidError');
}

function baselineValue(item: ConcreteItem): OverlayValue {
  return readTargetValue(root, parseOverlayKey(item.key), models);
}

/**
 * Pads with ASCII: BMP characters count as one UTF-16 unit and one code point, so the descriptor cap
 * (code points) and the zod cap (UTF-16) land on the same boundary.
 */
function pad(text: string, length: number): string {
  return text + 'a'.repeat(length - Array.from(text).length);
}

/** A value exactly at the descriptor's cap that still keeps every placeholder and check-in word. */
function maxText(item: ConcreteItem, silence: I18nBundle['silence']): string {
  const language = item.language ?? 'zh';
  let base = '';
  if (item.placeholders === 'auto') base += extractPlaceholders(baselineValue(item) as string).join('');
  if (item.rule === 'checkin') base += silence[language].listening[0]! + silence[language].anytime[0]!;
  if (item.pattern === 'wss_url') base = 'wss://example.invalid/';
  if (item.pattern === 'https_url') base = 'https://example.invalid/';
  return pad(base, item.maxChars![language]);
}

/** Max items, each exactly at the per-item cap and distinct, keeping every required token. */
function maxList(item: ConcreteItem): string[] {
  const language = item.language ?? 'zh';
  const length = item.itemMaxChars![language];
  const tokens = (item.requiredTokens ?? []).join('');
  return Array.from({ length: item.maxItems! }, (_, index) => pad(`${tokens}${index}`, length));
}

describe('buildConfigSnapshot', () => {
  it('with an empty overlay equals the startup loaders', () => {
    const snap = build({}, 0);
    expect(snap.version).toBe(0);
    expect(snap.pacing).toEqual(loadPacing(`${root}config/pacing.json`));
    expect(snap.memory).toEqual(loadMemoryBudget(`${root}config/memory.json`));
    expect(snap.affect).toEqual(loadAffectConfig(`${root}config/affect.json`));
    expect(snap.i18n).toEqual(loadI18n(`${root}config`));
    const roles = shippedRoles();
    for (const { characterId, language } of roles.characterLanguagePairs()) {
      expect(snap.roles.buildPersona(characterId, language)).toBe(roles.buildPersona(characterId, language));
      expect(snap.roles.director(characterId, language)).toEqual(roles.director(characterId, language));
    }
    expect(snap.model).toEqual({ ...models, extractModel: 'qwen-plus' });
    expect([...snap.disabledCharacters]).toEqual([]);
  });

  it('applies json, text, character and model overlay values', () => {
    const snap = build({
      'role:elder-companion/*/director.contextAfterMs': 9000,
      'role:elder-companion/zh/persona': '标记ABC\n{{charIdentity}}\n{{char}}',
      'character:xiaokai.voices.qwen.zh': 'Tina',
      'character:xiaoxin.enabled': false,
      'model:qwen.realtimeModel': 'qwen3.8-omni-flash-realtime',
      'memory:extractModel': 'qwen-flash',
      'pacing:restReminder.firstAfterMs': 5_400_000,
    });
    for (const language of LANGUAGES) expect(snap.roles.director('xiaonuan', language).contextAfterMs).toBe(9000);
    expect(snap.roles.buildPersona('xiaonuan', 'zh')).toContain('标记ABC');
    expect(snap.roles.buildPersona('xiaonuan', 'ja')).not.toContain('标记ABC');
    expect(snap.characters.voiceFor('xiaokai', 'qwen', 'zh')).toBe('Tina');
    expect([...snap.disabledCharacters]).toEqual(['xiaoxin']);
    expect(snap.model.extractModel).toBe('qwen-flash');
    expect(snap.pacing.restReminder.firstAfterMs).toBe(5_400_000);
  });

  it('explains cross-field and placeholder failures in Chinese', () => {
    expect(issuesOf({ 'pacing:restReminder.everyMs': 600_000 })).toEqual(['「之后每隔多久再提醒」不能短于「连续聊多久提醒休息」的一半。']);
    expect(issuesOf({ 'role:elder-companion/zh/persona': '没有占位符的人设' })).toEqual(['人设里少了 {{charIdentity}}（角色性格插入的位置），请加回去。']);
    expect(issuesOf({ 'character:xiaonuan.enabled': false, 'character:xiaokai.enabled': false, 'character:xiaoxin.enabled': false })).toEqual(['至少要留一个角色开着。']);
    expect(issuesOf({ 'model:qwen.realtimeEndpoint': 'http://example.invalid' })).toEqual(['「通话服务地址」必须以 wss:// 开头。']);
    expect(issuesOf({ 'pacing:noSuchField': 1 })).toEqual(['有一项配置在当前版本的默认配置里已经不存在（pacing:noSuchField）。']);
  });

  it('removes its temp directory on success and failure', () => {
    build({});
    issuesOf({ 'pacing:restReminder.everyMs': 600_000 });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('every numeric descriptor builds at its min and max', { timeout: 120_000 }, () => {
    const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, { languages: LANGUAGES, characters: CHARACTER_IDS, models: adminModels });
    for (const item of catalog.all().filter((i) => i.control === 'number')) {
      for (const shown of [item.min!, item.max!]) {
        expect(() => build({ [item.key]: toStored(item, shown) }), `${item.key}=${shown}`).not.toThrow();
      }
    }
  });

  it('every text and list descriptor builds at its cap', { timeout: 120_000 }, () => {
    const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, { languages: LANGUAGES, characters: CHARACTER_IDS, models: adminModels });
    const i18n = loadI18n(`${root}config`);
    const options = adminOptions;
    for (const item of catalog.all()) {
      const language = item.language ?? 'zh';
      if (item.control === 'text' || item.control === 'textarea') {
        const value = maxText(item, i18n.silence);
        // The generated value must sit exactly on the cap and still be acceptable to the admin validator.
        expect(Array.from(value).length, item.key).toBe(item.maxChars![language]);
        expect(validateDisplayValue(item, value, { baseline: baselineValue(item), silence: i18n.silence, options }), item.key)
          .toEqual({ ok: true, stored: value });
        expect(() => build({ [item.key]: value }), `${item.key} at maxChars ${item.maxChars![language]}`).not.toThrow();
      } else if (item.control === 'list') {
        const value = maxList(item);
        expect(value, item.key).toHaveLength(item.maxItems!);
        for (const entry of value) expect(Array.from(entry).length, item.key).toBe(item.itemMaxChars![language]);
        expect(validateDisplayValue(item, value, { baseline: baselineValue(item), silence: i18n.silence, options }), item.key)
          .toEqual({ ok: true, stored: value });
        expect(() => build({ [item.key]: value }), `${item.key} at maxItems ${item.maxItems!}`).not.toThrow();
      }
    }
  });
});
