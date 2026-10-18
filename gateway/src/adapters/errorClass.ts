import type { ErrorClass } from '../reliability/policy.ts';

const FATAL = new Set(['qwen_session_rejected', 'qwen_invalid_json', 'qwen_connect_closed', 'qwen_connect_timeout', 'upstream_invalid_json']);

/**
 * Maps an adapter error code onto the shared policy classes.
 * `invalid_request_error` is ignorable only during a tool turn (duplicate response.create).
 * Outside a tool turn, it is fatal (e.g., initialization failure).
 */
export function classifyAdapterError(code: string, toolTurnActive: boolean): ErrorClass {
  if (code === 'invalid_request_error' && toolTurnActive) return 'ignorable';
  if (FATAL.has(code) || code === 'invalid_request_error') return 'fatal';
  return 'retryable';
}
