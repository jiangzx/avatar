import { describe, expect, it } from 'vitest';
import { isTextualToolCall, stripTextualToolCall } from '../src/session/textGuard.ts';

describe('textual tool-call guard', () => {
  it('detects call syntax and code prefixes', () => {
    expect(isTextualToolCall('[call]\nset_memory_consent({"granted":"granted"})')).toBe(true);
    expect(isTextualToolCall('  {"query":"上次聊了什么"}')).toBe(true);
    expect(isTextualToolCall('```json\n{"a":1}\n```')).toBe(true);
    expect(isTextualToolCall('set_memory_consent({"granted":"granted"})')).toBe(true);
    expect(isTextualToolCall('您好呀，又见面了。')).toBe(false);
    expect(isTextualToolCall('我想聊聊[电影]。')).toBe(false);
  });

  it('strips the call line and everything after it', () => {
    expect(stripTextualToolCall('您好呀。\n[call] set_memory_consent({"granted":"granted"})')).toBe('您好呀。');
    expect(stripTextualToolCall('[call] set_memory_consent({"granted":"granted"})')).toBe('');
    expect(stripTextualToolCall('您好呀。')).toBe('您好呀。');
  });
});
