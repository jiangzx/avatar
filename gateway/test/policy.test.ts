import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorCodeOf, runWithPolicy, type PolicySpec } from '../src/reliability/policy.ts';

const spec: PolicySpec = { timeoutMs: 1000, retries: 2, backoffMs: 100, maxBackoffMs: 150 };

describe('runWithPolicy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns the value on first success', async () => {
    await expect(runWithPolicy('t', spec, async () => 7, { log: () => {} })).resolves.toEqual({ ok: true, value: 7, attempts: 1 });
  });

  it('retries retryable errors with capped exponential backoff', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await runWithPolicy('t', spec, async () => { if (++n < 3) throw new Error('upstream_busy'); return 'ok'; }, { sleep: async (ms) => { sleeps.push(ms); }, log: () => {} });
    expect(r).toEqual({ ok: true, value: 'ok', attempts: 3 });
    expect(sleeps).toEqual([100, 150]);
  });

  it('turns a timeout into a retryable failure, logs it, and returns the fallback', async () => {
    const logs: string[] = [];
    const p = runWithPolicy('summarize', { ...spec, retries: 0 }, () => new Promise<string>(() => {}), { fallback: () => 'old', log: (e, f) => logs.push(`${e}:${String(f.code)}`) });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ ok: false, code: 'summarize_timeout', errorClass: 'retryable', attempts: 1, fallback: 'old' });
    expect(logs).toEqual(['policy_failed:summarize_timeout']);
  });

  it('aborts the task signal on timeout', async () => {
    let aborted = false;
    const p = runWithPolicy('t', { ...spec, retries: 0 }, (signal) => new Promise<void>(() => { signal.addEventListener('abort', () => { aborted = true; }); }), { log: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(aborted).toBe(true);
  });

  it('does not retry fatal errors and does not log ignorable ones as failures', async () => {
    let n = 0;
    const logs: string[] = [];
    const fatal = await runWithPolicy('t', spec, async () => { n++; throw new Error('bad_request'); }, { classify: () => 'fatal', log: (e) => logs.push(e) });
    expect(fatal).toMatchObject({ ok: false, code: 'bad_request', errorClass: 'fatal', attempts: 1 });
    expect(n).toBe(1);
    const ignorable = await runWithPolicy('t', spec, async () => { throw new Error('duplicate'); }, { classify: () => 'ignorable', log: (e) => logs.push(e) });
    expect(ignorable).toMatchObject({ ok: false, errorClass: 'ignorable', attempts: 1 });
    expect(logs).toEqual(['policy_failed', 'policy_ignored']);
  });

  it('never turns free-form error text into a log code', () => {
    expect(errorCodeOf(new Error('summarizer_http_503'))).toBe('summarizer_http_503');
    expect(errorCodeOf(new Error('用户说了一句话'))).toBe('error');
    expect(errorCodeOf('nope')).toBe('error');
  });
});
