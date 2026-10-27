// High-risk memory contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { defaultLogger, type Logger } from '../log/logger.ts';
import type { SafetyRules } from '../config.ts';
import { grounded, parsePhrase } from '../memory/grounding.ts';
import { scanText } from '../memory/scan.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy } from '../reliability/policy.ts';

/**
 * One caring question about an unresolved matter the user stated in an earlier session.
 * The quote is input only; the line must pass the recall grounding checks, the safety scan,
 * and the length cap. Any failure or the deadline returns null (plain safe greeting instead).
 */
export async function generateCareLine(
  client: TextModelClient,
  system: string,
  input: { userLine: string; daysAgo: number },
  opts: { timeoutMs: number; maxChars: number; maxTokens: number; temperature: number },
  safety: SafetyRules,
  logger: Logger = defaultLogger(),
): Promise<string | null> {
  // runWithPolicy aborts the request through its AbortController at the deadline.
  const result = await runWithPolicy(
    'care',
    { timeoutMs: opts.timeoutMs, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
    (signal) => client.complete({
      system,
      user: JSON.stringify({ userLine: input.userLine, daysAgo: input.daysAgo }),
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      jsonMode: true,
      signal,
    }),
    { classify: () => 'ignorable', logger },
  );
  if (!result.ok) return null;
  const text = parsePhrase(result.value);
  if (!text || [...text].length > opts.maxChars) return null;
  if (scanText(text, safety) === 'reject') return null;
  if (!grounded(text, input.userLine)) return null;
  return text;
}

/** Greeting head with the name filled in, then the care line. Latin text needs a space between sentences. */
export function composeCareGreeting(template: string, name: string, line: string): string {
  const head = template.replaceAll('{name}', name).trim();
  return /[!-~]$/.test(head) ? `${head} ${line}` : `${head}${line}`;
}
