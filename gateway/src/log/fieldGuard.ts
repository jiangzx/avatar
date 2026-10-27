import type { LogFields } from './logger.ts';

/** Field names containing any of these (lower-cased) may carry conversation content. */
export const BANNED_FIELD_WORDS = ['text', 'transcript', 'content', 'reply', 'utterance', 'prompt', 'message', 'instruction', 'quote', 'summary'] as const;
export const MAX_FIELD_CHARS = 120;
/** Count or flag fields whose names happen to contain a banned word. Values must be number or boolean. */
export const ALLOWED_FIELD_NAMES: ReadonlySet<string> = new Set(['reply_chars', 'instructions', 'messages']);

/** Strict mode throws on the first bad field; lenient mode drops it and reports the name. */
export function guardFields(event: string, fields: LogFields, strict: boolean): { fields: LogFields; rejected: string[] } {
  const out: LogFields = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(fields) as Array<[string, unknown]>) {
    if (value === undefined) continue;
    if (!acceptable(key, value)) {
      if (strict) throw new Error(`log_field_rejected:${event}:${key}`);
      rejected.push(key);
      continue;
    }
    out[key] = typeof value === 'string' && value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : (value as LogFields[string]);
  }
  return { fields: out, rejected };
}

function acceptable(key: string, value: unknown): boolean {
  const primitive = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  if (!primitive) return false;
  if (ALLOWED_FIELD_NAMES.has(key)) return typeof value === 'number' || typeof value === 'boolean';
  const lower = key.toLowerCase();
  return !BANNED_FIELD_WORDS.some((word) => lower.includes(word));
}
