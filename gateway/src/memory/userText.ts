import type { SafetyRules } from '../config.ts';
import { redact } from './redact.ts';
import { scanText } from './scan.ts';

const EDGES = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

/** One line: newlines and runs of spaces become one space, so a stored line cannot forge a prompt line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Drops leading and trailing whitespace and punctuation. Run before redact: '*' is punctuation. */
export function trimEdges(text: string): string {
  return text.replace(EDGES, '');
}

export type CleanResult = { ok: true; text: string } | { ok: false };

/**
 * Same safety chain as transcript writes, stricter: only an `allow` verdict passes, because the
 * result goes into prompts verbatim. Long digit runs are masked. Never logs the text.
 */
export function cleanUserLine(text: string, rules: SafetyRules): CleanResult {
  if (scanText(text, rules) !== 'allow') return { ok: false };
  const line = oneLine(redact(text));
  return line ? { ok: true, text: line } : { ok: false };
}
