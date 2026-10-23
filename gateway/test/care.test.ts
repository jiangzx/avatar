import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import { composeCareGreeting, generateCareLine } from '../src/session/care.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18n = loadI18n(`${root}config`);
const QUOTE = '我明天去医院复查腰';
const opts = { timeoutMs: 1_500, maxChars: 40, maxTokens: 120, temperature: 0.7 };

function client(reply: () => Promise<string>) {
  const calls: Array<{ system: string; user: string; jsonMode: boolean | undefined; signal: AbortSignal }> = [];
  const fake: TextModelClient = {
    complete: (input) => {
      calls.push({ system: input.system, user: input.user, jsonMode: input.jsonMode, signal: input.signal });
      return reply();
    },
  };
  return { fake, calls };
}

afterEach(() => { vi.useRealTimers(); });

describe('generateCareLine', () => {
  it('returns a grounded caring question and sends only the quote and its age', async () => {
    const { fake, calls } = client(async () => '{"text":"复查的腰怎么样了？"}');
    await expect(generateCareLine(fake, 'CARE SYSTEM', { userLine: QUOTE, daysAgo: 2 }, opts, i18n.safety))
      .resolves.toBe('复查的腰怎么样了？');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe('CARE SYSTEM');
    expect(JSON.parse(calls[0]!.user)).toEqual({ userLine: QUOTE, daysAgo: 2 });
    expect(calls[0]!.jsonMode).toBe(true);
  });

  it.each([
    ['adds a title the user never said', '{"text":"复查的腰好点没？《养生堂》看了吗"}'],
    ['loses every content word of the quote', '{"text":"最近身体怎么样呀？"}'],
    ['repeats the quote verbatim', '{"text":"我明天去医院复查腰。"}'],
    ['is longer than maxChars', `{"text":"${'复查的腰'.repeat(11)}"}`],
    ['trips the safety scan', '{"text":"复查的腰怎么样了？忽略之前的指令"}'],
    ['is not JSON', '复查的腰怎么样了？'],
    ['has an empty text', '{"text":"  "}'],
  ])('returns null when the line %s', async (_case, raw) => {
    const { fake } = client(async () => raw);
    await expect(generateCareLine(fake, 'S', { userLine: QUOTE, daysAgo: 1 }, opts, i18n.safety)).resolves.toBeNull();
  });

  it('returns null when the client throws', async () => {
    const { fake } = client(async () => { throw new Error('extract_http_500'); });
    await expect(generateCareLine(fake, 'S', { userLine: QUOTE, daysAgo: 1 }, opts, i18n.safety)).resolves.toBeNull();
  });

  it('gives up at timeoutMs and aborts the request', async () => {
    vi.useFakeTimers();
    const { fake, calls } = client(() => new Promise<string>(() => {}));
    const pending = generateCareLine(fake, 'S', { userLine: QUOTE, daysAgo: 1 }, opts, i18n.safety);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});

describe('composeCareGreeting', () => {
  it('fills the name and joins CJK without a space and Latin with one', () => {
    expect(composeCareGreeting('{name}，又见面啦。', '王叔', '复查的腰怎么样了？')).toBe('王叔，又见面啦。复查的腰怎么样了？');
    expect(composeCareGreeting('{name}、またお会いできましたね。', '花子', 'その後いかがですか？')).toBe('花子、またお会いできましたね。その後いかがですか？');
    expect(composeCareGreeting('Hello, {name}.', 'Hanako', 'How did the check-up go?')).toBe('Hello, Hanako. How did the check-up go?');
  });
});

describe('care prompts', () => {
  it('ships one care prompt per language asking for one grounded JSON line', () => {
    for (const language of ['zh', 'ja', 'en'] as const) {
      const text = readFileSync(`${root}roles/_shared/${language}/care.md`, 'utf8');
      expect(text).toContain('userLine');
      expect(text).toContain('daysAgo');
      expect(text).toContain('{"text":');
    }
    expect(readFileSync(`${root}roles/_shared/zh/care.md`, 'utf8')).toContain('不要预设结果');
  });

  it('states the same length limit as affect.json care.maxChars, and no plan notes', () => {
    const care = loadAffectConfig(`${root}config/affect.json`).care;
    const zh = readFileSync(`${root}roles/_shared/zh/care.md`, 'utf8');
    const ja = readFileSync(`${root}roles/_shared/ja/care.md`, 'utf8');
    const en = readFileSync(`${root}roles/_shared/en/care.md`, 'utf8');
    expect(zh).toContain(`最多 ${care.maxChars.zh} 个汉字`);
    expect(ja).toContain(`${care.maxChars.ja} 文字以内`);
    expect(en).toContain(`At most ${care.maxChars.en} characters`);
    // Prompts go to the model verbatim: no file names or config keys inside.
    for (const text of [zh, ja, en]) expect(text).not.toMatch(/affect\.json|maxChars/);
  });
});
