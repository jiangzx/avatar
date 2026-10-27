import { describe, expect, it } from 'vitest';
import { expectedAudioTokens, idLikeHeaderNames, idLikePaths, leafShape, usagePaths } from '../scripts/lib/usage-probe.ts';

describe('usage probe helpers', () => {
  it('keeps numbers and replaces every string with its length only', () => {
    const shape = leafShape({ usage: { input_tokens: 12, input_tokens_details: { audio_tokens: 7, text_tokens: 5 } }, note: '秘密内容', ok: true, none: null });
    expect(shape).toEqual({
      'usage.input_tokens': 12,
      'usage.input_tokens_details.audio_tokens': 7,
      'usage.input_tokens_details.text_tokens': 5,
      note: 'string(4)',
      ok: 'boolean',
      none: 'null',
    });
    expect(JSON.stringify(shape)).not.toContain('秘密');
  });

  it('describes arrays by length and the shape of their first element', () => {
    expect(leafShape({ choices: [{ index: 0, message: { content: '你好' } }, { index: 1 }] })).toEqual({
      'choices.length': 2,
      'choices[0].index': 0,
      'choices[0].message.content': 'string(2)',
    });
  });

  it('finds every nested usage object path', () => {
    expect(usagePaths({ type: 'response.done', response: { usage: { total_tokens: 3 } } })).toEqual(['response.usage']);
    expect(usagePaths({ usage: { a: 1 }, item: { usage: { b: 2 } } })).toEqual(['usage', 'item.usage']);
    expect(usagePaths({ type: 'x' })).toEqual([]);
  });

  it('lists id-like keys that carry a non-empty string, without values', () => {
    expect(idLikePaths({ event_id: 'evt_1', error: { request_id: 'r1', code: 'bad', message: 'secret' }, id: '' })).toEqual(['event_id', 'error.request_id']);
  });

  it('keeps only request or trace header names', () => {
    expect(idLikeHeaderNames(['content-type', 'X-Request-Id', 'x-dashscope-request-id', 'eagleeye-traceid', 'date'])).toEqual([
      'x-request-id', 'x-dashscope-request-id', 'eagleeye-traceid',
    ]);
  });

  it('rounds partial seconds up like the official audio token rule', () => {
    expect(expectedAudioTokens(2.1, 7)).toBe(21);
    expect(expectedAudioTokens(3, 12.5)).toBe(38);
  });
});
