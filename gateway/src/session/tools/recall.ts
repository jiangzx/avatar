// High-risk recall contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { z } from 'zod';
import type { SafetyRules } from '../../config.ts';
import { fillerWords, vagueKey } from '../../i18n/text.ts';
import { isMemoryEvidence } from '../../memory/evidence.ts';
import { ftsMatch } from '../../memory/fts.ts';
import { grounded, parsePhrase, sameUtterance } from '../../memory/grounding.ts';
import { scanText } from '../../memory/scan.ts';
import type { TextModelClient } from '../../memory/textClient.ts';
import { matchKeyword } from '../actions.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

export { ftsMatch };

// TUNABLE: enough rows to skip recent test chatter; vague recall picks one session, not a global window.
const RECENT_WINDOW = 50;
// TUNABLE: greetings and very short commands are not memories.
const RECENT_MIN_CHARS = 5;
// TUNABLE: short action requests ("你点点头") are not memories.
const RECENT_ACTION_CMD_MAX_CHARS = 20;
// TUNABLE: a real recollection is longer than test chatter; prefer a session with one.
const RECENT_STRONG_CHARS = 15;
// TUNABLE: Qwen may send the transcript after the tool call; wait this long for the user's line.
const RECALL_FINAL_WAIT_MS = 1_000;

const RecallSchema = z.object({ query: z.string().min(1).max(2_000) }).strict();

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

/** Whole-utterance key: ignore whitespace and edge punctuation/symbols. */
function utteranceKey(text: string): string {
  return text
    .replace(/\s/g, '')
    .toLowerCase()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}

/** A bare vague question stays vague; content after the phrase must go to FTS instead. */
function isRecentQuery(query: string, copy: RecallCopy): boolean {
  const normalized = query.replace(/\s/g, '').toLowerCase();
  const leading = fillerWords(copy.recentQueryLeadingFillers);
  const trailing = fillerWords(copy.recentQueryTrailingFillers);
  const key = vagueKey(query, leading, trailing);
  if (copy.recentQueryExactPatterns.some((pattern) => {
    const value = vagueKey(pattern, leading, trailing);
    return value.length > 0 && key === value;
  })) return true;
  return copy.recentQueryPatterns.some((pattern) => {
    const value = utteranceKey(pattern);
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
  /** One-line confirmation template; `{line}` is the verbatim first hit. */
  recentConfirmText: string;
  /** Tells the model the gateway already quoted the line and asked for confirmation. */
  recentConfirmInstruction: string;
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
  /** Bare vague questions; bounded leading/trailing fillers still count as vague. */
  recentQueryExactPatterns: readonly string[];
  /** Words ignored before an exact vague question. */
  recentQueryLeadingFillers: readonly string[];
  /** Words ignored after an exact vague question. */
  recentQueryTrailingFillers: readonly string[];
  /** First-person "I said" frames; stripped before FTS so frame words alone cannot hit. */
  queryFramePatterns: readonly RegExp[];
  /** System prompt for natural phrasing of a grounded line. */
  phraseInstruction: string;
  /** Spoken phrasing cap; longer output falls back to the verbatim quote. */
  phraseMaxChars: number;
  /** Vague-recall candidate window; omitted = shipped default. */
  recentWindow?: number;
  /** Shortest recent-memory line; omitted = shipped default. */
  recentMinChars?: number;
  /** Longest short action request ignored by vague recall; omitted = shipped default. */
  actionCommandMaxChars?: number;
  /** Prefer a session with a statement this long; omitted = shipped default. */
  strongChars?: number;
  /** Phrasing deadline; timeout falls back to the verbatim quote. */
  phraseTimeoutMs: number;
}

export function recallTool(rules: SafetyRules, clipChars: number, copy: RecallCopy, finalWaitMs: number = RECALL_FINAL_WAIT_MS): ToolHandler {
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
      return recall(args, ctx, rules, clipChars, copy, finalWaitMs);
    },
  };
}

function isActionCommand(text: string, maxChars: number): boolean {
  return [...text].length <= maxChars && matchKeyword(text) !== null;
}

/** This turn's user final, even when the realtime transcript arrives after the tool call. */
async function turnFinalText(ctx: ToolContext, timeoutMs: number): Promise<string> {
  try {
    const final = await ctx.turn.currentFinal(timeoutMs);
    return final?.text.trim() ?? '';
  } catch {
    return '';
  }
}

async function recall(args: unknown, ctx: ToolContext, rules: SafetyRules, clipChars: number, copy: RecallCopy, finalWaitMs: number): Promise<ToolOutcome> {
  const parsed = RecallSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: 'invalid_args' };
  const { store, ownerId, agentId } = ctx;
  // Scope keys come only from the server-side session (spec §5); no agent, no recall.
  if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
  const query = parsed.data.query;
  const evidence = { questionPatterns: copy.questionPatterns, skipPatterns: copy.skipPatterns, lightAcks: copy.lightAcks };
  // The model may shorten the user's sentence; use the user's own line for the vague-recall branch.
  // Qwen can call the tool before its transcript arrives, so wait briefly for this turn's final.
  const triggerText = ctx.triggerText?.trim() || await turnFinalText(ctx, finalWaitMs);
  const recentSource = triggerText || query;
  // Vague "what did we talk about" questions have no useful FTS tokens; use recent user statements.
  if (isRecentQuery(recentSource, copy)) {
    const window = copy.recentWindow ?? RECENT_WINDOW;
    const minChars = copy.recentMinChars ?? RECENT_MIN_CHARS;
    const actionMax = copy.actionCommandMaxChars ?? RECENT_ACTION_CMD_MAX_CHARS;
    const strongChars = copy.strongChars ?? RECENT_STRONG_CHARS;
    const rows = store.recentUserMessagesBySession(ownerId, agentId, window);
    const bySession = new Map<string, string[]>();
    for (const row of rows) {
      const text = stripInvisible(row.text, rules.invisibleCodePoints);
      if (text.length === 0 || scanText(text, rules) === 'reject') continue;
      if (!isMemoryEvidence(text, evidence)) continue;
      if ([...text].length < minChars || isActionCommand(text, actionMax)) continue;
      const lines = bySession.get(row.sessionId) ?? [];
      lines.push(clip(text, clipChars));
      bySession.set(row.sessionId, lines);
    }
    // Rows are newest first. Prefer the newest session with a real recollection; a test/command
    // session is usually short, so it must not hide the last substantive chat.
    const groups = [...bySession.values()];
    const chosen = groups.find((lines) => lines.some((line) => [...line].length >= strongChars)) ?? groups[0];
    const recent = chosen?.slice(0, 3) ?? [];
    ctx.logger?.info('recall_path', {
      path: 'recent',
      query_chars: query.length,
      trigger: triggerText ? 1 : 0,
      rows: rows.length,
      sessions: groups.length,
      used: recent.length,
    });
    return confirmOutcome(recent, copy, await phrase(ctx.textClient, recent[0], copy, rules, true));
  }
  const searchText = contentQuery(query, copy.queryFramePatterns);
  const match = ftsMatch(searchText);
  // A single character has no bigrams; fall back to LIKE within this owner's user lines.
  const rows = match
    ? store.searchMessages(ownerId, agentId, match, 50)
    : [...searchText].length === 1
      ? store.searchMessagesLike(ownerId, agentId, `%${escapeLike(searchText)}%`, 50)
      : [];
  if (rows.length === 0) {
    ctx.logger?.info('recall_path', { path: 'fts', query_chars: query.length, trigger: triggerText ? 1 : 0, hits: 0 });
    return outcome([], copy);
  }
  const trigger = triggerText || undefined;
  const lines: string[] = [];
  for (const row of rows) {
    const stripped = stripInvisible(row.text, rules.invisibleCodePoints);
    if (!stripped || scanText(stripped, rules) === 'reject') continue;
    if (trigger && sameUtterance(stripped, trigger)) continue;
    if (!isMemoryEvidence(stripped, evidence)) continue;
    lines.push(clip(stripped, clipChars));
    if (lines.length === 3) break;
  }
  ctx.logger?.info('recall_path', { path: 'fts', query_chars: query.length, trigger: triggerText ? 1 : 0, hits: lines.length });
  return outcome(lines, copy, await phrase(ctx.textClient, lines[0], copy, rules));
}

/** Ask the text model to phrase one grounded line naturally; any failure keeps the verbatim quote. */
async function phrase(
  client: TextModelClient | undefined,
  source: string | undefined,
  copy: RecallCopy,
  rules: SafetyRules,
  confirm = false,
): Promise<string | undefined> {
  if (!client || !source) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), copy.phraseTimeoutMs);
  try {
    const raw = await client.complete({
      system: copy.phraseInstruction,
      user: JSON.stringify(confirm ? { userLine: source, confirm: true } : { userLine: source }),
      maxTokens: 120,
      temperature: 0.7,
      jsonMode: true,
      signal: controller.signal,
    });
    const text = parsePhrase(raw);
    if (!text || [...text].length > copy.phraseMaxChars) return undefined;
    if (scanText(text, rules) === 'reject') return undefined;
    if (!grounded(text, source)) return undefined;
    // A confirmation that does not ask anything leaves the user unable to answer.
    if (confirm && !/[？?]\s*$/u.test(text) && !copy.questionPatterns.some((pattern) => pattern.test(text))) return undefined;
    return text;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Speak the grounded line, never a canned continuation (pitfall #6). */
function outcome(lines: readonly string[], copy: RecallCopy, phrased?: string): ToolOutcome {
  if (lines.length === 0) return { ok: true, text: copy.wrapText, spokenText: copy.emptyText, spokenFound: false };
  return {
    ok: true,
    text: `${copy.wrapText}\n${lines.join('\n')}`,
    spokenText: phrased ?? `${copy.foundPrefix}${lines[0]}`,
    spokenFound: true,
  };
}

/**
 * A vague recollection states the first grounded line and asks whether it is the right
 * thing. The text model makes the sentence natural; a failed or ungrounded phrasing falls
 * back to the verbatim template. The model still gets every line in the tool text so the
 * next turn can continue the topic.
 */
function confirmOutcome(lines: readonly string[], copy: RecallCopy, phrased?: string): ToolOutcome {
  if (lines.length === 0) return { ok: true, text: copy.wrapText, spokenText: copy.emptyText, spokenFound: false };
  const quoted = stripFinalPunct(lines[0]);
  return {
    ok: true,
    text: `${copy.recentConfirmInstruction}\n${copy.wrapText}\n${lines.join('\n')}`,
    spokenText: phrased ?? copy.recentConfirmText.replace('{line}', quoted),
    spokenFound: true,
  };
}

/** Drop trailing spaces and sentence punctuation so the template does not double it. */
function stripFinalPunct(text: string): string {
  return text.replace(/[\s。.!！?？…~～]+$/u, '');
}
