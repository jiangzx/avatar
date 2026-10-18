import { describe, expect, it } from 'vitest';
import { classifyAdapterError } from '../src/adapters/errorClass.ts';

describe('classifyAdapterError', () => {
  it('ignores a duplicate response.create only during a tool turn', () => {
    expect(classifyAdapterError('invalid_request_error', true)).toBe('ignorable');
    expect(classifyAdapterError('invalid_request_error', false)).toBe('fatal');
  });
  it('treats a rejected session and bad frames as fatal', () => {
    expect(classifyAdapterError('qwen_session_rejected', false)).toBe('fatal');
    expect(classifyAdapterError('qwen_invalid_json', true)).toBe('fatal');
    expect(classifyAdapterError('upstream_invalid_json', true)).toBe('fatal');
    expect(classifyAdapterError('upstream_invalid_json', false)).toBe('fatal');
  });
  it('retries a dropped socket', () => {
    expect(classifyAdapterError('qwen_socket_error', false)).toBe('retryable');
    expect(classifyAdapterError('qwen_error', false)).toBe('retryable');
  });
});
