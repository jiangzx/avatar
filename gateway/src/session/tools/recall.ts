// High-risk recall contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { z } from 'zod';
import type { SafetyRules } from '../../config.ts';
import { bigrams } from '../../memory/bigram.ts';
import { isMemoryEvidence } from '../../memory/evidence.ts';
import { scanText } from '../../memory/scan.ts';
import type { TextModelClient } from '../../memory/textClient.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

const RecallSchema = z.object({ query: z.string().min(1).max(2_000) }).strict();

/** FTS expression for the same tokens `bigrams` stored. Null when the query has none. */
export function ftsMatch(text: string, match: 'any' | 'all' = 'any'): string | null {
  const tokens = bigrams(text).split(' ').filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(match === 'all' ? ' AND ' : ' OR ');
}

function stripInvisible(text: string, codePoints: readonly number[]): string {
  const banned = new Set(codePoints);
  return [...text].filter((ch) => {
    const point = ch.codePointAt(0);
    return point === undefined || !banned.has(point);
  }).join('');
}

function clip(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/** Escape LIKE wildcards for a bound pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Punctuation-insensitive comparison so the current question never becomes its own memory hit. */
function sameUtterance(a: string, b: string): boolean {
  const normalize = (text: string) => text.replace(/[\s，。！？、,.!?~～…—「」『』“”"'・]/g, '');
  return normalize(a) === normalize(b);
}

/** A bare vague question stays vague; "what did we say about X" must go to FTS instead. */
function isRecentQuery(normalized: string, copy: RecallCopy): boolean {
  const key = normalized.replace(/[?？!！.。…]+$/u, '');
  const norm = (pattern: string) => pattern.replace(/\s/g, '').toLowerCase();
  if (copy.recentQueryExactPatterns.some((pattern) => {
    const value = norm(pattern);
    return value.length > 0 && key === value;
  })) return true;
  return copy.recentQueryPatterns.some((pattern) => {
    const value = norm(pattern);
    return value.length > 0 && normalized.includes(value);
  });
}

/** FTS only sees the content after a first-person "I said" frame; an empty result keeps the trimmed query. */
function contentQuery(query: string, patterns: readonly RegExp[]): string {
  // Trim first: every frame pattern is anchored, so leading whitespace must not bypass it.
  const trimmed = query.trim();
  let text = trimmed;
  for (const pattern of patterns) text = text.replace(pattern, '');
  return text.trim() || trimmed;
}

export interface RecallCopy {
  /** Spoken when there is no usable user line. */
  emptyText: string;
  /** Prefix for a grounded spoken quote of the first hit. */
  foundPrefix: string;
  /** Wraps the verbatim lines sent back to the model as history, not instructions. */
  wrapText: string;
  /** Tool schema description for recall_memory. */
  toolDescription: string;
  /** Query parameter description for recall_memory. */
  queryDescription: string;
  /** Challenge or denial lines are not evidence that the user said the thing. */
  skipPatterns: readonly string[];
  /** Whole-utterance acknowledgements are not evidence; substrings are. */
  lightAcks: readonly string[];
  /** Question shapes per language (the question mark alone is not enough when ASR drops it). */
  questionPatterns: readonly RegExp[];
  /** Vague "what did we talk about" queries answer from recent user statements instead of FTS. */
  recentQueryPatterns: readonly string[];
  /** Bare vague questions; extra content after the phrase makes it a specific FTS query. */
  recentQueryExactPatterns: readonly string[];
  /** First-person "I said" frames; stripped before FTS so frame words alone cannot hit. */
  queryFramePatterns: readonly RegExp[];
  /** System prompt for natural phrasing of a grounded line. */
  phraseInstruction: string;
  /** Spoken phrasing cap; longer output falls back to the verbatim quote. */
  phraseMaxChars: number;
  /** Phrasing deadline; timeout falls back to the verbatim quote. */
  phraseTimeoutMs: number;
}

export function recallTool(rules: SafetyRules, clipChars: number, copy: RecallCopy): ToolHandler {
  return {
    spec: {
      name: 'recall_memory',
      description: copy.toolDescription,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: copy.queryDescription } },
        required: ['query'],
      },
    },
    handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      return recall(args, ctx, rules, clipChars, copy);
    },
  };
}

async function recall(args: unknown, ctx: ToolContext, rules: SafetyRules, clipChars: number, copy: RecallCopy): Promise<ToolOutcome> {
  const parsed = RecallSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: 'invalid_args' };
  if (!ctx.store || !ctx.ownerId) return { ok: false, error: 'memory_unavailable' };
  const query = parsed.data.query;
  const evidence = { questionPatterns: copy.questionPatterns, skipPatterns: copy.skipPatterns, lightAcks: copy.lightAcks };
  // Vague "what did we talk about" questions have no useful FTS tokens; use recent user statements.
  // Normalize whitespace and case on both sides: en patterns are lowercase and contain spaces.
  const normalized = query.replace(/\s/g, '').toLowerCase();
  if (isRecentQuery(normalized, copy)) {
    const recent = ctx.store.recentUserMessages(ctx.ownerId, 12)
      .map((row) => stripInvisible(row.text, rules.invisibleCodePoints))
      .filter((text) => text.length > 0 && scanText(text, rules) !== 'reject' && isMemoryEvidence(text, evidence))
      .slice(0, 3)
      .map((text) => clip(text, clipChars));
    return outcome(recent, copy, await phrase(ctx.textClient, recent[0], copy, rules));
  }
  const searchText = contentQuery(query, copy.queryFramePatterns);
  const match = ftsMatch(searchText);
  // A single character has no bigrams; fall back to LIKE within this owner's user lines.
  const rows = match
    ? ctx.store.searchMessages(ctx.ownerId, match, 50)
    : [...searchText].length === 1
      ? ctx.store.searchMessagesLike(ctx.ownerId, `%${escapeLike(searchText)}%`, 50)
      : [];
  if (rows.length === 0) return outcome([], copy);
  const trigger = ctx.triggerText?.trim();
  const lines: string[] = [];
  for (const row of rows) {
    const stripped = stripInvisible(row.text, rules.invisibleCodePoints);
    if (!stripped || scanText(stripped, rules) === 'reject') continue;
    if (trigger && sameUtterance(stripped, trigger)) continue;
    if (!isMemoryEvidence(stripped, evidence)) continue;
    lines.push(clip(stripped, clipChars));
    if (lines.length === 3) break;
  }
  return outcome(lines, copy, await phrase(ctx.textClient, lines[0], copy, rules));
}

/** Ask the text model to phrase one grounded line naturally; any failure keeps the verbatim quote. */
async function phrase(client: TextModelClient | undefined, source: string | undefined, copy: RecallCopy, rules: SafetyRules): Promise<string | undefined> {
  if (!client || !source) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), copy.phraseTimeoutMs);
  try {
    const raw = await client.complete({
      system: copy.phraseInstruction,
      user: JSON.stringify({ userLine: source }),
      maxTokens: 120,
      temperature: 0.7,
      jsonMode: true,
      signal: controller.signal,
    });
    const text = parsePhrase(raw);
    if (!text || [...text].length > copy.phraseMaxChars) return undefined;
    if (scanText(text, rules) === 'reject') return undefined;
    if (!grounded(text, source)) return undefined;
    return text;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function parsePhrase(raw: string): string | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(text) as { text?: unknown };
    return typeof value.text === 'string' && value.text.trim() ? value.text.trim() : null;
  } catch {
    return null;
  }
}

/** Reject a phrasing that adds a new quoted title or loses every content bigram from the source. */
function grounded(text: string, source: string): boolean {
  if (sameUtterance(text, source)) return false;
  for (const match of text.matchAll(/[《「『“"]([^》」』”"]{1,20})[》」』”"]/g)) {
    if (!source.includes(match[1]!)) return false;
  }
  // Latin bigrams are whole words, so the two-character Han gate does not apply to them.
  const tokens = bigrams(source).split(' ').filter((token) => token.length >= 2);
  return tokens.some((token) => text.includes(token));
}

/** Seeduplex cannot continue a tool turn; speak the grounded line instead of a canned reply. */
function outcome(lines: readonly string[], copy: RecallCopy, phrased?: string): ToolOutcome {
  if (lines.length === 0) return { ok: true, text: copy.wrapText, spokenText: copy.emptyText, spokenFound: false };
  return {
    ok: true,
    text: `${copy.wrapText}\n${lines.join('\n')}`,
    spokenText: phrased ?? `${copy.foundPrefix}${lines[0]}`,
    spokenFound: true,
  };
}
