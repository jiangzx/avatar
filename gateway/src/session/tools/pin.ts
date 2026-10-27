import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SafetyRules } from '../../config.ts';
import { containsPhrase } from '../../i18n/text.ts';
import type { EvidenceRules, PinCopy } from '../../i18n/types.ts';
import { log } from '../../log.ts';
import { cleanUserLine, trimEdges } from '../../memory/userText.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

/** Strict: the model never passes content, only which user line to pin. */
const PinSchema = z.object({ target: z.enum(['this', 'previous']) }).strict();

export interface PinOptions {
  copy: PinCopy;
  /** Union question patterns and light acks; a question is not something to remember. */
  evidence: EvidenceRules;
  safety: SafetyRules;
  /** Union of every language's health words. */
  healthWords: readonly string[];
  maxPerCharacter: number;
  /** Code-point limit for the current language (Q34). */
  maxChars: number;
  /** How long to wait for this turn's user final (pinFinalWaitMs). */
  turnFinalTimeoutMs: number;
}

const ASCII_WORD = /[a-z0-9]/i;

function byLength(words: readonly string[]): string[] {
  return [...words].filter((word) => word.length > 0).sort((a, b) => b.length - a.length);
}

/** ASCII phrases must end on a word boundary ("remember" must not eat "Remembering"). */
function asciiBoundary(word: string, next: string | undefined): boolean {
  return !/^[\x20-\x7E]+$/.test(word) || next === undefined || !ASCII_WORD.test(next);
}

/** Content of a "this" line: trigger prefixes and trailing trigger/filler words removed, repeatedly. */
export function pinContent(text: string, copy: Pick<PinCopy, 'triggerPrefixes' | 'trailingWords'>): string {
  const prefixes = byLength(copy.triggerPrefixes);
  const tails = byLength(copy.trailingWords);
  let out = trimEdges(text);
  for (let changed = true; changed && out.length > 0;) {
    changed = false;
    const lower = out.toLowerCase();
    const head = prefixes.find((word) => lower.startsWith(word.toLowerCase()) && asciiBoundary(word, out[word.length]));
    if (head) {
      out = trimEdges(out.slice(head.length));
      changed = true;
      continue;
    }
    const tail = tails.find((word) => lower.endsWith(word.toLowerCase()) && asciiBoundary(word, out[out.length - word.length - 1]));
    if (tail) {
      out = trimEdges(out.slice(0, out.length - tail.length));
      changed = true;
    }
  }
  return out;
}

/** Question shapes and whole-utterance light acks are never pinned. */
function isQuestionOrAck(text: string, rules: EvidenceRules): boolean {
  if (/[？?]\s*$/.test(text)) return true;
  if (rules.questionPatterns.some((pattern) => pattern.test(text))) return true;
  const key = text.replace(/[\s。！？!?，,、.~～…]+/gu, '').toLowerCase();
  return rules.lightAcks.some((ack) => ack.replace(/[\s。！？!?，,、.~～…]+/gu, '').toLowerCase() === key);
}

function refuse(error: string, spokenText: string): ToolOutcome {
  return { ok: false, error, spokenText, spokenFound: false };
}

export function pinTool(options: PinOptions): ToolHandler {
  const { copy } = options;
  return {
    spec: {
      name: 'pin_memory',
      description: copy.toolDescription,
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['this', 'previous'], description: copy.targetDescription } },
        required: ['target'],
      },
    },
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const parsed = PinSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_args' };
      const { store, ownerId, agentId } = ctx;
      if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
      // Same gate as transcript writes (spec §5). Nothing to wait for when the answer is no.
      const gate = ctx.memoryGate();
      if (gate === 'declined') return refuse('pin_declined', copy.declinedText);
      if (gate === 'notice_pending') return refuse('pin_notice_pending', copy.noticePendingText);
      const pinned = store.listPinned(ownerId, agentId);
      if (pinned.length >= options.maxPerCharacter) return refuse('pin_full', copy.fullText);
      // this / previous are both located relative to this turn's final being in the ledger.
      const current = await ctx.turn.currentFinal(options.turnFinalTimeoutMs);
      if (!current) return refuse('pin_no_final', copy.emptyText);
      const target = parsed.data.target;
      const source = target === 'this' ? current : ctx.turn.previousFinal();
      if (!source) return refuse('pin_no_previous', copy.emptyText);
      const content = target === 'this' ? pinContent(source.text, copy) : trimEdges(source.text);
      if ([...content].length < 2) return refuse('pin_empty', copy.emptyText);
      if (isQuestionOrAck(content, options.evidence)) return refuse('pin_question', copy.emptyText);
      const cleaned = cleanUserLine(content, options.safety);
      if (!cleaned.ok) return refuse('pin_rejected', copy.emptyText);
      const text = cleaned.text;
      // Never truncate: a clipped pin could remember the wrong thing (Q34).
      if ([...text].length > options.maxChars) return refuse('pin_too_long', copy.tooLongText);
      if (pinned.some((row) => row.text === text)) return { ok: true, spokenText: copy.confirmText, spokenFound: true };
      const sensitive = options.healthWords.some((word) => containsPhrase(text, word));
      store.insertPinned({
        id: randomUUID(),
        ownerId,
        agentId,
        text,
        sensitive,
        sourceSessionId: ctx.sessionId,
        sourceMessageId: source.messageId,
        now: ctx.now,
      });
      log('memory_pinned', { sensitive, count: pinned.length + 1 });
      return { ok: true, spokenText: copy.confirmText, spokenFound: true, refreshSnapshot: true };
    },
  };
}
