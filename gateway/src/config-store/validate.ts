import type { Language } from '@anyidea/protocol';
import type { SilenceRules } from '../i18n/types.ts';
import { extractPlaceholders, type ConcreteItem } from './descriptors.ts';
import type { OverlayValue } from './keys.ts';
import { optionsFor, type QwenOptions } from './options.ts';
import { toStored } from './units.ts';

export interface ValidateContext { baseline: OverlayValue; silence: Record<Language, SilenceRules>; options: QwenOptions }
export type ValidateResult = { ok: true; stored: OverlayValue } | { ok: false; message: string };

export const UNIT_WORDS: Record<string, string> = { second: '秒', minute: '分钟', day: '天', count: '条', char: '字', level: '级' };
/** What a placeholder stands for, in words an admin understands. */
export const TOKEN_MEANINGS: Record<string, string> = {
  '{name}': '老人称呼',
  '{{char}}': '角色名字',
  '{{charSpoken}}': '角色名字的读音',
  '{{charIdentity}}': '角色性格介绍',
  '{topic}': '话题',
  '{utterance}': '老人原话',
};

const chars = (text: string) => Array.from(text).length;
const meaning = (token: string) => TOKEN_MEANINGS[token] ?? '程序要用的内容';

export function validateDisplayValue(item: ConcreteItem, value: unknown, ctx: ValidateContext): ValidateResult {
  const fail = (message: string): ValidateResult => ({ ok: false, message });
  const label = `「${item.label}」`;
  const language = item.language ?? 'zh';
  switch (item.control) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${label}需要填数字。`);
      const unit = UNIT_WORDS[item.unit!] ?? '';
      if (value > item.max!) return fail(`${label}最大 ${item.max} ${unit}。`);
      if (value < item.min!) return fail(`${label}最小 ${item.min} ${unit}。`);
      const steps = (value - item.min!) / item.step!;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return fail(`${label}要按 ${item.step} ${unit}一档调整。`);
      return { ok: true, stored: toStored(item, value) };
    }
    case 'switch':
      return typeof value === 'boolean' ? { ok: true, stored: value } : fail(`${label}只能是开或关。`);
    case 'select': {
      if (typeof value !== 'string') return fail(`${label}只能从列表里选。`);
      const allowed = optionsFor(ctx.options, item.options!, item.language).map((option) => option.value);
      return allowed.includes(value) ? { ok: true, stored: value } : fail(`${label}只能从列表里选。`);
    }
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string' || !value.trim()) return fail(`${label}不能为空。`);
      const text = value.trim();
      const max = item.maxChars![language];
      if (chars(text) > max) return fail(`${label}最多 ${max} 个字，现在 ${chars(text)} 个。`);
      if (item.pattern === 'wss_url' && !isUrl(text, 'wss:')) return fail('地址必须以 wss:// 开头。');
      if (item.pattern === 'https_url' && !isUrl(text, 'https:')) return fail('地址必须以 https:// 开头。');
      for (const token of item.requiredTokens ?? []) {
        if (!text.includes(token)) return fail(`${label}里少了 ${token}，这是${meaning(token)}的位置，请加回去。`);
      }
      if (item.placeholders === 'auto' && typeof ctx.baseline === 'string') {
        const expected = extractPlaceholders(ctx.baseline);
        for (const token of expected) {
          if (!text.includes(token)) return fail(`${label}里少了 ${token}，这是${meaning(token)}的位置，请加回去。`);
        }
        const unknown = extractPlaceholders(text).find((token) => !expected.includes(token));
        if (unknown) return fail(`${label}里的 ${unknown} 无法识别，请删掉。`);
      }
      if (item.rule === 'checkin' && !passesCheckin(text, ctx.silence[language])) {
        return fail(`${label}要问老人还在不在听，并说随时可以接着聊。`);
      }
      return { ok: true, stored: text };
    }
    case 'list': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return fail(`${label}格式不对。`);
      const list = (value as string[]).map((entry) => entry.trim());
      const min = item.minItems ?? 1;
      if (list.length < min) return fail(`${label}至少要有 ${min} 条。`);
      if (list.length > item.maxItems!) return fail(`${label}最多 ${item.maxItems} 条。`);
      if (new Set(list).size !== list.length) return fail(`${label}里有重复的内容。`);
      const max = item.itemMaxChars![language];
      for (const [index, entry] of list.entries()) {
        if (!entry) return fail(`${label}第 ${index + 1} 条是空的。`);
        if (chars(entry) > max) return fail(`${label}第 ${index + 1} 条最多 ${max} 个字。`);
        for (const token of item.requiredTokens ?? []) {
          if (!entry.includes(token)) return fail(`${label}第 ${index + 1} 条里少了 ${token}，这是${meaning(token)}的位置，请加回去。`);
        }
      }
      return { ok: true, stored: list };
    }
  }
}

function isUrl(text: string, protocol: string): boolean {
  try {
    return new URL(text).protocol === protocol;
  } catch {
    return false;
  }
}

/** Same content rule the Director applies to planned check-ins (listening + anytime words, length cap). */
function passesCheckin(text: string, rules: SilenceRules): boolean {
  const lower = text.toLowerCase();
  const has = (words: readonly string[]) => words.some((word) => lower.includes(word.toLowerCase()));
  return chars(text) <= rules.maxCheckinChars && has(rules.listening) && has(rules.anytime);
}
