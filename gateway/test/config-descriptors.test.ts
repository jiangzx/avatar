import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadDescriptorCatalog, extractPlaceholders, type ConcreteItem } from '../src/config-store/descriptors.ts';
import { getJsonPath, parseOverlayKey, readTargetValue, setJsonPath, targetFiles, type ModelDefaults } from '../src/config-store/keys.ts';
import { loadAdminOptions, optionsFor } from '../src/config-store/options.ts';
import { toDisplay, toStored } from '../src/config-store/units.ts';
import { validateDisplayValue } from '../src/config-store/validate.ts';
import { loadI18n } from '../src/i18n/load.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/api-ws/v1/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/compatible-mode/v1/chat/completions',
  summarizerModel: 'qwen-flash',
};
const options = loadAdminOptions(root);
const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, {
  languages: LANGUAGES,
  characters: CHARACTER_IDS,
  models: options.realtimeModels.map((option) => option.value),
});
const silence = loadI18n(`${root}config`).silence;

function baseline(item: ConcreteItem) {
  return readTargetValue(root, parseOverlayKey(item.key), models);
}

describe('overlay keys', () => {
  it('maps each domain to its file and path', () => {
    expect(parseOverlayKey('pacing:restReminder.firstAfterMs')).toEqual({ kind: 'json', file: 'config/pacing.json', path: ['restReminder', 'firstAfterMs'] });
    expect(parseOverlayKey('i18n:ja/memory.recall.emptyText')).toEqual({ kind: 'json', file: 'config/i18n/ja/memory.json', path: ['recall', 'emptyText'] });
    expect(parseOverlayKey('role:elder-companion/zh/persona')).toEqual({ kind: 'text', file: 'roles/elder-companion/zh/persona.md' });
    expect(parseOverlayKey('role:elder-companion/*/director.contextAfterMs')).toEqual({ kind: 'json', file: 'roles/elder-companion/*/director.json', path: ['contextAfterMs'] });
    expect(parseOverlayKey('character:xiaonuan.enabled')).toEqual({ kind: 'characterEnabled', characterId: 'xiaonuan' });
    expect(parseOverlayKey('character:xiaokai.voices.qwen.zh')).toEqual({ kind: 'json', file: 'characters/xiaokai.json', path: ['voices', 'qwen', 'zh'] });
    expect(parseOverlayKey('model:qwen.realtimeModel')).toEqual({ kind: 'model', field: 'realtimeModel' });
    expect(parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh')).toEqual({
      kind: 'voice', model: 'qwen-audio-3.1-realtime-flash', character: 'xiaonuan', language: 'zh',
    });
  });

  it('rejects malformed, unknown and prototype keys', () => {
    for (const bad of [
      'pacing', 'nope:x', 'pacing:', 'pacing:a..b', 'pacing:__proto__.x', 'pacing:constructor', 'memory:prototype',
      'role:elder-companion/*/persona', 'role:elder-companion/zh/persona.x', 'role:elder-companion/fr/director.a',
      'character:lily.enabled', 'model:qwen.apiKey', 'model:seeduplex.realtimeModel', 'i18n:zh/memory', 'i18n:zh/../x.a',
    ]) expect(() => parseOverlayKey(bad), bad).toThrow(/^overlay_key_invalid:/);
  });

  it('expands * to every language of the role pack', () => {
    expect(targetFiles(root, { file: 'roles/elder-companion/*/director.json' })).toEqual([
      'roles/elder-companion/zh/director.json', 'roles/elder-companion/ja/director.json', 'roles/elder-companion/en/director.json',
    ]);
  });

  it('gets and sets only existing own paths', () => {
    const doc = { a: { b: [1, 2] } };
    expect(getJsonPath(doc, ['a', 'b', '1'])).toBe(2);
    expect(getJsonPath(doc, ['a', 'toString'])).toBeUndefined();
    setJsonPath(doc, ['a', 'b'], ['x']);
    expect(doc.a.b).toEqual(['x']);
    expect(() => setJsonPath(doc, ['a', 'c'], 1)).toThrow(/^overlay_target_missing:/);
  });
});

describe('descriptor catalog', () => {
  it('has the seven scenes in order', () => {
    expect(catalog.scenes().map((s) => s.id)).toEqual(['pacing', 'affect', 'proactivity', 'memory', 'characters', 'copy', 'model']);
  });

  it('expands {lang} and {char} and keeps keys unique', () => {
    const keys = catalog.all().map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('character:xiaoxin.identity.ja');
    expect(keys).toContain('i18n:en/memory.restReminderText');
    expect(keys).toContain('character:xiaokai.enabled');
    expect(keys.some((k) => k.includes('{'))).toBe(false);
    const identity = catalog.find('character:xiaoxin.identity.ja')!;
    expect(identity.character).toBe('xiaoxin');
    expect(identity.language).toBe('ja');
    expect(identity.descriptorKey).toBe('character:{char}.identity.{lang}');
  });

  it('expands {model} and resolves voices from that model catalog', () => {
    const item = catalog.find('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh')!;
    expect(item.model).toBe('qwen-audio-3.1-realtime-flash');
    expect(item.character).toBe('xiaonuan');
    expect(item.language).toBe('zh');
    expect(item.descriptorKey).toBe('voice:{model}/{char}.{lang}');
    expect(optionsFor(options, item.options!, 'zh', item.model).map((option) => option.value)).toContain('longanlingxin_v3.1');
    expect(catalog.find('character:xiaonuan.voices.qwen.zh')).toBeUndefined();
  });

  it('never whitelists technical or safety fields', () => {
    const forbidden = [/^pacing:(rebuild|tailGuardMs|slim|policies|push|output)/, /safety/, /_shared/, /director\.\w*Instruction/, /bargeMiss/, /memoryNotice/, /pinMaxPerCharacter/];
    for (const item of catalog.all()) for (const pattern of forbidden) expect(item.key, item.key).not.toMatch(pattern);
  });

  it('every concrete key resolves to a baseline value that passes its own validation', () => {
    for (const item of catalog.all()) {
      const stored = baseline(item);
      const result = validateDisplayValue(item, toDisplay(item, stored), { baseline: stored, silence, options });
      expect(result, `${item.key}: ${result.ok ? '' : result.message}`).toEqual({ ok: true, stored });
    }
  });

  it('number ranges contain the baseline and step evenly', () => {
    for (const item of catalog.all().filter((i) => i.control === 'number')) {
      const shown = toDisplay(item, baseline(item)) as number;
      expect(shown, item.key).toBeGreaterThanOrEqual(item.min!);
      expect(shown, item.key).toBeLessThanOrEqual(item.max!);
      expect(Number.isInteger((item.max! - item.min!) / item.step!), item.key).toBe(true);
    }
  });

  it('caps rest reminders at 120 minutes (compliance)', () => {
    expect(catalog.find('pacing:restReminder.firstAfterMs')!.max).toBe(120);
    expect(catalog.find('pacing:restReminder.everyMs')!.max).toBe(120);
  });

  it('every high-risk item explains the consequence', () => {
    for (const item of catalog.all().filter((i) => i.risk === 'high')) expect(item.riskNote, item.key).toBeTruthy();
  });

  it('select items offer the current value', () => {
    for (const item of catalog.all().filter((i) => i.control === 'select')) {
      const values = optionsFor(options, item.options!, item.language, item.model).map((o) => o.value);
      expect(values, item.key).toContain(baseline(item));
    }
  });
});

describe('units', () => {
  it('converts ms to seconds and minutes and back', () => {
    const seconds = catalog.find('role:elder-companion/*/director.contextAfterMs')!;
    expect(toDisplay(seconds, 6000)).toBe(6);
    expect(toStored(seconds, 7)).toBe(7000);
    const minutes = catalog.find('pacing:restReminder.firstAfterMs')!;
    expect(toDisplay(minutes, 3_600_000)).toBe(60);
    expect(toStored(minutes, 90)).toBe(5_400_000);
  });
});

describe('validateDisplayValue', () => {
  const ctx = (item: ConcreteItem) => ({ baseline: baseline(item), silence, options });

  it('rejects out-of-range and off-step numbers in Chinese', () => {
    const item = catalog.find('pacing:restReminder.firstAfterMs')!;
    expect(validateDisplayValue(item, 125, ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」最大 120 分钟。' });
    expect(validateDisplayValue(item, 5, ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」最小 10 分钟。' });
    expect(validateDisplayValue(item, 62, ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」要按 5 分钟一档调整。' });
    expect(validateDisplayValue(item, '60', ctx(item))).toEqual({ ok: false, message: '「连续聊多久提醒休息」需要填数字。' });
  });

  it('keeps every placeholder of the persona', () => {
    const item = catalog.find('role:elder-companion/zh/persona')!;
    const text = (baseline(item) as string).replaceAll('{{charIdentity}}', '');
    const result = validateDisplayValue(item, text, ctx(item));
    expect(result).toEqual({ ok: false, message: '「三个角色共用的人设」里少了 {{charIdentity}}，这是角色性格介绍的位置，请加回去。' });
  });

  it('rejects placeholders the baseline does not have', () => {
    const item = catalog.find('role:elder-companion/zh/persona')!;
    const result = validateDisplayValue(item, `${baseline(item) as string}\n{{owner}}`, ctx(item));
    expect(result).toEqual({ ok: false, message: '「三个角色共用的人设」里的 {{owner}} 无法识别，请删掉。' });
  });

  it('requires {name} in every first-meet line', () => {
    const item = catalog.find('character:xiaonuan.greetingsFirstMeet.zh')!;
    const result = validateDisplayValue(item, ['您好，我是小暖。'], ctx(item));
    expect(result).toEqual({ ok: false, message: '「第一次知道称呼时的开场白」第 1 条里少了 {name}，这是老人称呼的位置，请加回去。' });
  });

  it('applies the check-in content rule', () => {
    const item = catalog.find('role:elder-companion/zh/director.checkinText')!;
    expect(validateDisplayValue(item, '我先安静一会儿。', ctx(item))).toEqual({
      ok: false, message: '「问「还在听吗」的备用话」要问老人还在不在听，并说随时可以接着聊。',
    });
  });

  it('accepts only listed models and https/wss addresses', () => {
    const model = catalog.find('model:qwen.realtimeModel')!;
    expect(validateDisplayValue(model, 'gpt-x', ctx(model))).toEqual({ ok: false, message: '「通话用的模型」只能从列表里选。' });
    const ws = catalog.find('model:qwen.realtimeEndpoint')!;
    expect(validateDisplayValue(ws, 'http://example.com', ctx(ws))).toEqual({ ok: false, message: '地址必须以 wss:// 开头。' });
    const http = catalog.find('model:qwen.textEndpoint')!;
    expect(validateDisplayValue(http, 'ftp://example.com', ctx(http))).toEqual({ ok: false, message: '地址必须以 https:// 开头。' });
  });

  it('accepts only voices in the model catalog', () => {
    const item = catalog.find('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh')!;
    expect(validateDisplayValue(item, 'longanlingxin_v3.1', ctx(item)).ok).toBe(true);
    expect(validateDisplayValue(item, 'Tina', ctx(item)).ok).toBe(false);
  });

  it('extracts both placeholder styles once each', () => {
    expect(extractPlaceholders('{{char}} {name} {{char}} {topic}')).toEqual(['{{char}}', '{name}', '{topic}']);
  });
});
