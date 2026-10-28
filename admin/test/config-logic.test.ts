import { describe, expect, it } from 'vitest';
import { formatSeconds, formatValue, rowLabel } from '../src/config/format.ts';
import { effectiveValue, resetToDefault, setValue, toDraft } from '../src/config/draft.ts';
import { rowErrors } from '../src/config/validate.ts';
import { diffText } from '../src/config/textDiff.ts';
import { contextItem, enabledItem, endpointItem, extractModelItem, lightItem, personaItem, restItem } from './fixtures/config.ts';

describe('format', () => {
  it('shows values in plain words', () => {
    expect(formatValue(restItem, 90)).toBe('90 分钟');
    expect(formatValue(contextItem, 6)).toBe('6 秒');
    expect(formatValue(enabledItem, true)).toBe('开');
    expect(formatValue(lightItem, ['嗯', '好'])).toBe('嗯、好');
    expect(formatValue(extractModelItem, 'qwen-flash')).toBe('通义千问 Flash');
    expect(formatValue(endpointItem, 'wss://a.example/x')).toBe('wss://a.example/x');
    expect(formatValue(personaItem, '一'.repeat(30))).toBe(`${'一'.repeat(24)}…`);
  });

  it('formats elapsed seconds', () => {
    expect(formatSeconds(6)).toBe('6 秒');
    expect(formatSeconds(180)).toBe('3 分');
    expect(formatSeconds(214)).toBe('3 分 34 秒');
  });

  it('names the character on per-character rows', () => {
    expect(rowLabel(enabledItem)).toBe('是否启用（小凯）');
    expect(rowLabel(restItem)).toBe('连续聊多久提醒休息');
  });
});

describe('draft', () => {
  it('drops a change that returns to the published value', () => {
    const changed = setValue({}, restItem, 60);
    expect(changed[restItem.key]).toEqual({ value: 60, reset: false });
    expect(setValue(changed, restItem, 90)).toEqual({});
  });

  it('resets an overridden item through the resets list; a default item just drops the edit', () => {
    const reset = resetToDefault({}, restItem);
    expect(reset[restItem.key]).toEqual({ value: 60, reset: true });
    expect(effectiveValue(restItem, reset)).toBe(60);
    expect(toDraft(reset, 7)).toEqual({ baseVersion: 7, changes: [], resets: [restItem.key] });
    const edited = setValue({}, contextItem, 9);
    expect(toDraft(edited, 7)).toEqual({ baseVersion: 7, changes: [{ key: contextItem.key, value: 9 }], resets: [] });
    expect(resetToDefault(edited, contextItem)).toEqual({});
  });
});

describe('row validation', () => {
  it('explains range errors in display units', () => {
    expect(rowErrors(restItem, 150)).toEqual(['可以填 10 到 120 分钟。']);
    expect(rowErrors(restItem, 60)).toEqual([]);
  });

  it('names the missing placeholder and what it is for', () => {
    expect(rowErrors(personaItem, '你是小暖，陪老人聊天。')).toEqual(['「三个角色共用的人设」里少了 {{char}}，这是角色名字的位置，请加回去。']);
  });

  it('limits text length by characters', () => {
    const long = `{{char}}${'好'.repeat(1600)}`;
    expect(rowErrors(personaItem, long)).toEqual([`最多 1600 字，现在 ${Array.from(long).length} 字。`]);
  });

  it('checks the address scheme the item needs', () => {
    expect(rowErrors(endpointItem, 'https://example.com')).toEqual(['地址必须以 wss:// 开头。']);
    expect(rowErrors(endpointItem, 'wss://example.com/v1')).toEqual([]);
  });

  it('checks word lists', () => {
    expect(rowErrors(lightItem, [])).toEqual(['至少要留 1 个词。']);
    expect(rowErrors(lightItem, ['嗯', '好', '对', '是'])).toEqual(['最多 3 个词。']);
    expect(rowErrors(lightItem, ['嗯嗯嗯嗯嗯嗯嗯'])).toEqual(['每个词最多 6 个字。']);
  });
});

describe('diffText', () => {
  it('marks insertions and deletions by character', () => {
    expect(diffText('今天天气好', '今天天气真好')).toEqual([
      { type: 'same', text: '今天天气' },
      { type: 'ins', text: '真' },
      { type: 'same', text: '好' },
    ]);
    expect(diffText('慢慢说，不着急', '慢慢说')).toEqual([
      { type: 'same', text: '慢慢说' },
      { type: 'del', text: '，不着急' },
    ]);
  });

  it('falls back to whole-block replace when the texts are too large', () => {
    expect(diffText('甲乙丙', '丁戊己', 4)).toEqual([
      { type: 'del', text: '甲乙丙' },
      { type: 'ins', text: '丁戊己' },
    ]);
  });
});
