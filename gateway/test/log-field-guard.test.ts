import { describe, expect, it } from 'vitest';
import { ALLOWED_FIELD_NAMES, BANNED_FIELD_WORDS, MAX_FIELD_CHARS, guardFields } from '../src/log/fieldGuard.ts';

describe('guardFields', () => {
  it('bans the agreed content words', () => {
    expect([...BANNED_FIELD_WORDS]).toEqual(['text', 'transcript', 'content', 'reply', 'utterance', 'prompt', 'message', 'instruction', 'quote', 'summary']);
  });

  it('passes ids, counts, durations and codes unchanged', () => {
    expect(guardFields('x', { code: 'qwen_error', ms: 12, ok: true, none: null }, true)).toEqual({ fields: { code: 'qwen_error', ms: 12, ok: true, none: null }, rejected: [] });
  });

  it('rejects any field whose lower-cased name contains a banned word, in strict mode by throwing', () => {
    for (const name of ['text', 'userText', 'replyText', 'TRANSCRIPT', 'promptBody', 'summary_zh', 'lastMessage']) {
      expect(() => guardFields('affect', { [name]: 'x' }, true)).toThrow(`log_field_rejected:affect:${name}`);
    }
  });

  it('drops banned fields in lenient mode and reports their names', () => {
    expect(guardFields('affect', { text: '腰疼', ms: 3 }, false)).toEqual({ fields: { ms: 3 }, rejected: ['text'] });
  });

  it('allows the listed count and flag fields only with number or boolean values', () => {
    expect([...ALLOWED_FIELD_NAMES].sort()).toEqual(['instructions', 'messages', 'reply_chars']);
    expect(guardFields('reply_metrics', { reply_chars: 12 }, true).fields).toEqual({ reply_chars: 12 });
    expect(guardFields('session_push', { instructions: true }, true).fields).toEqual({ instructions: true });
    expect(guardFields('memory_extract', { messages: 4 }, true).fields).toEqual({ messages: 4 });
    expect(() => guardFields('memory_extract', { messages: '你好' } as never, true)).toThrow('log_field_rejected:memory_extract:messages');
  });

  it('truncates long strings to the cap in both modes', () => {
    const long = 'a'.repeat(MAX_FIELD_CHARS + 30);
    expect(MAX_FIELD_CHARS).toBe(120);
    expect(guardFields('x', { code: long }, true).fields.code).toBe('a'.repeat(120));
    expect(guardFields('x', { code: long }, false).fields.code).toBe('a'.repeat(120));
  });

  it('rejects non-primitive values and skips undefined ones', () => {
    expect(() => guardFields('x', { detail: { a: 1 } } as never, true)).toThrow('log_field_rejected:x:detail');
    expect(guardFields('x', { a: undefined, b: 1 } as never, true).fields).toEqual({ b: 1 });
  });
});
