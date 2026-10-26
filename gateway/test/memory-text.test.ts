import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSharedSafety, type SafetyRules } from '../src/config.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { backfillKanaBigrams } from '../src/memory/backfill.ts';
import { bigrams } from '../src/memory/bigram.ts';
import { openDatabase } from '../src/memory/db.ts';
import { normalizeChineseDigits, redact } from '../src/memory/redact.ts';
import { scanText } from '../src/memory/scan.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { ftsMatch } from '../src/session/tools/recall.ts';
import { seedOwner } from './helpers/memory.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const safetyPath = `${root}config/safety.json`;

describe('redact', () => {
  it('masks a long digit run and leaves a single numeral inside a word', () => {
    expect(redact('一二三四五六七八九零一二')).toBe('************');
    expect(redact('一个')).toBe('一个');
    expect(redact('张三')).toBe('张三');
    expect(normalizeChineseDigits('一个')).toBe('一个');
    expect(normalizeChineseDigits('张三')).toBe('张三');
  });

  it('leaves an 11-digit phone number unchanged', () => {
    expect(redact('13800138000')).toBe('13800138000');
    expect(redact('一三八零零一三八零零零')).toBe('一三八零零一三八零零零');
  });

  it('masks twelve formal digits', () => {
    expect(redact('壹贰叁肆伍陆柒捌玖壹贰叁')).toBe('************');
  });

  it('masks each long digit run with the same number of stars', () => {
    expect(redact('卡123456789012尾')).toBe('卡************尾');
    expect(redact('1234567890123')).toBe('*************');
  });
});

describe('bigrams', () => {
  it('emits a Han pair and keeps a Latin run as one token', () => {
    expect(bigrams('王叔')).toBe('王叔');
    expect(bigrams('hello')).toBe('hello');
  });

  it('slides adjacent Han pairs and keeps each Latin or digit run whole', () => {
    expect(bigrams('今天天气不错')).toBe('今天 天天 天气 气不 不错');
    expect(bigrams('王叔hello123')).toBe('王叔 hello123');
    expect(bigrams('hello 123')).toBe('hello 123');
  });

  it('folds a digit run of at least two characters and keeps a lone numeral as Han', () => {
    expect(bigrams('一二三四五六七八九零一').split(' ')).toContain('12345678901');
    expect(bigrams('一个')).toBe('一个');
    expect(bigrams('张三')).toBe('张三');
    expect(bigrams('幺二')).toBe('12');
    expect(bigrams('一十')).toBe('一十');
    expect(bigrams('两三')).toBe('两三');
    expect(bigrams('一拾')).toBe('一拾');
  });

  it('indexes kana and mixed Japanese runs without changing zh/en tokens', () => {
    expect(bigrams('今日はいい天気ですね')).toEqual(expect.stringContaining('今日'));
    expect(bigrams('今日はいい天気ですね')).toEqual(expect.stringContaining('天気'));
    expect(bigrams('ヨガをしています')).toEqual(expect.stringContaining('ヨガ'));
    expect(bigrams('ヨガをしています')).toEqual(expect.stringContaining('して'));
    expect(bigrams('今天天气不错')).toBe('今天 天天 天气 气不 不错');
    expect(bigrams('hello world')).toBe('hello world');
  });
});

describe('kana backfill', () => {
  it('rewrites stale kana bigrams once so FTS finds the message', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1_000 });
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'kana-backfill', 1);
    store.insertMessage({
      id: 'kana-1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: 'ヨガをしています', bigrams: '', now: 2,
    });
    expect(store.searchMessages(created.ownerId, created.agentId, ftsMatch('ヨガ')!, 10)).toEqual([]);

    expect(backfillKanaBigrams(store, 100)).toBe(1);
    expect(store.searchMessages(created.ownerId, created.agentId, ftsMatch('ヨガ')!, 10).map((row) => row.text)).toEqual(['ヨガをしています']);

    // The row now carries kana tokens: a second pass changes nothing.
    expect(backfillKanaBigrams(store, 100)).toBe(0);
    db.close();
  });

  it('advances the kana backfill cursor past the first page', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1_000 });
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'kana-cursor', 1);
    const texts = [0, 1, 2].map((i) => `${i}ヨガをしています。`);
    texts.forEach((text, i) => store.insertMessage({
      id: `m${i}`, sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text, bigrams: '', now: i + 1,
    }));

    expect(backfillKanaBigrams(store, 2)).toBe(2);
    expect(backfillKanaBigrams(store, 2)).toBe(1); // third row, not the same first two
    // The third row is retrievable now, before the cursor wraps.
    expect(store.searchMessages(created.ownerId, created.agentId, ftsMatch('ヨガ')!, 10).map((row) => row.text)).toContain(texts[2]);
    expect(backfillKanaBigrams(store, 2)).toBe(0); // cursor wrapped; nothing left to change
    db.close();
  });

  it('leaves Han-only and Latin messages untouched and respects the batch limit', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1_000 });
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'kana-limit', 1);
    store.insertMessage({ id: 'zh', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天天气不错', bigrams: '', now: 2 });
    store.insertMessage({ id: 'en', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: 'hello', bigrams: '', now: 3 });
    store.insertMessage({ id: 'k1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: 'ヨガ', bigrams: '', now: 4 });
    store.insertMessage({ id: 'k2', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: 'お茶', bigrams: '', now: 5 });

    expect(backfillKanaBigrams(store, 3)).toBe(1);
    expect(store.searchMessages(created.ownerId, created.agentId, ftsMatch('ヨガ')!, 10)).toHaveLength(1);
    expect(store.searchMessages(created.ownerId, created.agentId, ftsMatch('お茶')!, 10)).toEqual([]);
    expect(backfillKanaBigrams(store, 100)).toBe(1);
    db.close();
  });

  it('ignores a non-positive backfill limit', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1_000 });
    const store = new SqliteMemoryStore(db);
    expect(backfillKanaBigrams(store, 0)).toBe(0);
    expect(backfillKanaBigrams(store, -1)).toBe(0);
    db.close();
  });
});

describe('scanText', () => {
  const rules = () => DEFAULT_I18N.safety;

  it('rejects a string that contains U+200B', () => {
    expect(scanText('你好\u200B', rules())).toBe('reject');
  });

  it('degrades verification-code talk without throwing', () => {
    expect(scanText('验证码是 123456', rules())).toBe('degrade');
  });

  it('marks a high false-positive phrase', () => {
    expect(scanText('你现在是', rules())).toBe('mark');
  });

  it('allows ordinary chat', () => {
    expect(scanText('今天天气不错', rules())).toBe('allow');
  });

  it('prefers reject over degrade and degrade over mark', () => {
    expect(scanText('验证码\u200B', rules())).toBe('reject');
    expect(scanText('你现在是验证码', rules())).toBe('degrade');
  });

  it('reads phrases from the rules', () => {
    const shipped = rules();
    const swapped: SafetyRules = {
      ...shipped,
      degradePhrases: ['转账'],
      markPhrases: ['随便标记'],
      invisibleCodePoints: [0x200C],
    };
    expect(scanText('验证码是 123456', swapped)).toBe('allow');
    expect(scanText('请你转账', swapped)).toBe('degrade');
    expect(scanText('你现在是', swapped)).toBe('allow');
    expect(scanText('你好\u200B', swapped)).toBe('allow');
  });
});

describe('loadSharedSafety', () => {
  it('parses the shipped safety.json shared fields', () => {
    const rules = loadSharedSafety(safetyPath);
    expect(Object.keys(rules).sort()).toEqual(['chineseDigits', 'invisibleCodePoints', 'minMaskedDigits']);
    expect(rules.minMaskedDigits).toBe(12);
    expect(rules.chineseDigits['零']).toBe('0');
    expect(rules.chineseDigits['幺']).toBe('1');
    expect(rules.chineseDigits['壹']).toBe('1');
    expect(rules.chineseDigits['贰']).toBe('2');
    expect(rules.chineseDigits['叁']).toBe('3');
    expect(rules.chineseDigits['肆']).toBe('4');
    expect(rules.chineseDigits['伍']).toBe('5');
    expect(rules.chineseDigits['陆']).toBe('6');
    expect(rules.chineseDigits['柒']).toBe('7');
    expect(rules.chineseDigits['捌']).toBe('8');
    expect(rules.chineseDigits['玖']).toBe('9');
    expect(rules.chineseDigits['两']).toBeUndefined();
    expect(rules.chineseDigits['十']).toBeUndefined();
    expect(rules.chineseDigits['拾']).toBeUndefined();
    expect(rules.invisibleCodePoints).toContain(0x200B);
  });

  it('merges every language pack into the shipped phrases', () => {
    const rules = DEFAULT_I18N.safety;
    expect(rules.degradePhrases).toContain('验证码');
    expect(rules.degradePhrases).toContain('转账');
    expect(rules.degradePhrases).toContain('银行卡');
    expect(rules.degradePhrases).toContain('verification code');
    expect(rules.markPhrases).toContain('你现在是');
    expect(rules.rejectPhrases.length).toBeGreaterThan(0);
    expect(new Set(rules.rejectPhrases).size).toBe(rules.rejectPhrases.length);
  });

  it('fails closed when the file has an unknown field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'safety-'));
    const rules = loadSharedSafety(safetyPath);
    writeFileSync(join(dir, 'safety.json'), JSON.stringify({ ...rules, extra: true }));
    expect(() => loadSharedSafety(join(dir, 'safety.json'))).toThrow();
  });
});
