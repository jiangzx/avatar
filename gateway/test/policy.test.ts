import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorCodeOf, runWithPolicy, type PolicySpec } from '../src/reliability/policy.ts';
import { captureLogger } from './helpers/logCapture.ts';

const spec: PolicySpec = { timeoutMs: 1000, retries: 2, backoffMs: 100, maxBackoffMs: 150 };

describe('runWithPolicy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns the value on first success', async () => {
    await expect(runWithPolicy('t', spec, async () => 7, { logger: captureLogger().logger })).resolves.toEqual({ ok: true, value: 7, attempts: 1 });
  });

  it('retries retryable errors with capped exponential backoff', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await runWithPolicy('t', spec, async () => { if (++n < 3) throw new Error('upstream_busy'); return 'ok'; }, { sleep: async (ms) => { sleeps.push(ms); }, logger: captureLogger().logger });
    expect(r).toEqual({ ok: true, value: 'ok', attempts: 3 });
    expect(sleeps).toEqual([100, 150]);
  });

  it('turns a timeout into a retryable failure, logs it, and returns the fallback', async () => {
    const cap = captureLogger();
    const p = runWithPolicy('summarize', { ...spec, retries: 0 }, () => new Promise<string>(() => {}), { fallback: () => 'old', logger: cap.logger });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ ok: false, code: 'summarize_timeout', errorClass: 'retryable', attempts: 1, fallback: 'old' });
    expect(cap.lines.map((l) => `${l.event}:${String(l.fields.code)}`)).toEqual(['policy_failed:summarize_timeout']);
  });

  it('ends with policy_failed once retries are exhausted, logging only content-free fields', async () => {
    const cap = captureLogger();
    let n = 0;
    const r = await runWithPolicy('t', { ...spec, retries: 1 }, async () => { n++; throw new Error('用户说了一句话'); }, { sleep: async () => {}, logger: cap.logger });
    expect(n).toBe(2);
    expect(r).toEqual({ ok: false, code: 'error', errorClass: 'retryable', attempts: 2 });
    expect(cap.lines.map((l) => [l.event, l.fields])).toEqual([
      ['policy_retry', { name: 't', code: 'error', attempt: 1 }],
      ['policy_failed', { name: 't', code: 'error', class: 'retryable', attempts: 2 }],
    ]);
  });

  it('aborts the task signal on timeout', async () => {
    let aborted = false;
    const p = runWithPolicy('t', { ...spec, retries: 0 }, (signal) => new Promise<void>(() => { signal.addEventListener('abort', () => { aborted = true; }); }), { logger: captureLogger().logger });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(aborted).toBe(true);
  });

  it('does not retry fatal errors and does not log ignorable ones as failures', async () => {
    const cap = captureLogger();
    let n = 0;
    const fatal = await runWithPolicy('t', spec, async () => { n++; throw new Error('bad_request'); }, { classify: () => 'fatal', logger: cap.logger });
    expect(fatal).toMatchObject({ ok: false, code: 'bad_request', errorClass: 'fatal', attempts: 1 });
    expect(n).toBe(1);
    const ignorable = await runWithPolicy('t', spec, async () => { throw new Error('duplicate'); }, { classify: () => 'ignorable', logger: cap.logger });
    expect(ignorable).toMatchObject({ ok: false, errorClass: 'ignorable', attempts: 1 });
    expect(cap.lines.map((l) => l.event)).toEqual(['policy_failed', 'policy_ignored']);
  });

  it('never turns free-form error text into a log code', () => {
    expect(errorCodeOf(new Error('summarizer_http_503'))).toBe('summarizer_http_503');
    expect(errorCodeOf(new Error('用户说了一句话'))).toBe('error');
    expect(errorCodeOf('nope')).toBe('error');
  });
});
