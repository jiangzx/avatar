import { log as defaultLog } from '../log.ts';

export type ErrorClass = 'ignorable' | 'retryable' | 'fatal';

export interface PolicySpec {
  timeoutMs: number;
  retries: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export type PolicyResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; code: string; errorClass: ErrorClass; attempts: number; fallback?: T };

export interface PolicyOptions<T> {
  classify?: (error: unknown) => ErrorClass;
  fallback?: () => T;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

export class PolicyTimeoutError extends Error {
  constructor(name: string) {
    super(`${name}_timeout`);
  }
}

const CODE = /^[a-z0-9_:.-]{1,64}$/;

/** Only short machine codes reach logs; anything else (possibly content) becomes "error". */
export function errorCodeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return CODE.test(message) ? message : 'error';
}

/** One place for timeout, retry with capped exponential backoff, and fallback. Never fails silently. */
export async function runWithPolicy<T>(
  name: string,
  spec: PolicySpec,
  task: (signal: AbortSignal) => Promise<T>,
  opts: PolicyOptions<T> = {},
): Promise<PolicyResult<T>> {
  const classify = opts.classify ?? (() => 'retryable' as const);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? defaultLog;
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PolicyTimeoutError(name));
        }, spec.timeoutMs);
      });
      const value = await Promise.race([task(controller.signal), timeout]);
      return { ok: true, value, attempts: attempt };
    } catch (error) {
      const errorClass: ErrorClass = error instanceof PolicyTimeoutError ? 'retryable' : classify(error);
      const code = errorCodeOf(error);
      if (errorClass === 'retryable' && attempt <= spec.retries) {
        log('policy_retry', { name, code, attempt });
        await sleep(Math.min(spec.backoffMs * 2 ** (attempt - 1), spec.maxBackoffMs));
        continue;
      }
      log(errorClass === 'ignorable' ? 'policy_ignored' : 'policy_failed', { name, code, class: errorClass, attempts: attempt });
      return { ok: false, code, errorClass, attempts: attempt, ...(opts.fallback ? { fallback: opts.fallback() } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }
}
