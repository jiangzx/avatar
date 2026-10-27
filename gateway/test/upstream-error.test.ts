import { afterEach, describe, expect, it, vi } from 'vitest';
import { qwenErrorRequestId } from '../src/adapters/qwen.ts';
import { QwenTextClient, UPSTREAM_REQUEST_ID_HEADERS } from '../src/memory/textClient.ts';
import { captureLogger } from './helpers/logCapture.ts';

afterEach(() => { vi.unstubAllGlobals(); });

describe('qwenErrorRequestId', () => {
  // P1-T1 probe A4: the realtime error event carries only a top-level `event_id`.
  it('reads the event id from the probed path', () => {
    expect(qwenErrorRequestId({ type: 'error', event_id: 'e1', error: { code: 'denied' } })).toBe('e1');
    expect(qwenErrorRequestId({ type: 'error', error: { message: 'x' } })).toBeUndefined();
    expect(qwenErrorRequestId({ type: 'error', event_id: '' })).toBeUndefined();
  });
});

describe('QwenTextClient upstream_error', () => {
  const client = (logger: ReturnType<typeof captureLogger>['logger']) =>
    new QwenTextClient({ apiKey: 'k', endpoint: 'https://example.invalid/v1/chat/completions', model: 'qwen-plus', logger });
  const call = (c: QwenTextClient) => c.complete({ system: 's', user: 'u', maxTokens: 5, signal: new AbortController().signal });

  it('logs status, code, model and the request id header without the body', async () => {
    const cap = captureLogger();
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"用户原话"}}', { status: 429, headers: { [UPSTREAM_REQUEST_ID_HEADERS[0]!]: 'req-9' } }));
    await expect(call(client(cap.logger))).rejects.toThrow('extract_http_429');
    expect(cap.events('upstream_error').map((l) => [l.level, l.fields])).toEqual([
      ['warn', { source: 'text', model: 'qwen-plus', code: 'extract_http_429', http_status: 429, upstream_request_id: 'req-9' }],
    ]);
    expect(JSON.stringify(cap.lines)).not.toContain('用户原话');
  });

  it('logs client errors at error level and omits a missing request id', async () => {
    const cap = captureLogger();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 400 }));
    await expect(call(client(cap.logger))).rejects.toThrow('extract_http_400');
    expect(cap.events('upstream_error').map((l) => [l.level, l.fields])).toEqual([
      ['error', { source: 'text', model: 'qwen-plus', code: 'extract_http_400', http_status: 400 }],
    ]);
  });
});
