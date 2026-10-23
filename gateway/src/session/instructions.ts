import type { LedgerEntry } from './ledger.ts';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';

export interface InstructionBudget {
  totalChars: number;
  snapshotMaxChars: number;
  summaryMaxChars: number;
  /** Room reserved for the affect section; missing means 0. The section itself is never clipped. */
  affectMaxChars?: number;
}

export interface InstructionParts {
  persona: string;
  /** Deterministic affect render (affectRender.ts); empty or missing leaves the section out. */
  affect?: string;
  memorySnapshot?: string;
  summary: string;
  recent: readonly LedgerEntry[];
}

const line = (e: LedgerEntry, labels: PromptLabels) =>
  `${e.role === 'user' ? labels.user : labels.assistant}${labels.separator}${e.text}`;

function render(
  persona: string,
  affect: string,
  snapshot: string,
  summary: string,
  lines: readonly string[],
  labels: PromptLabels,
): string {
  const parts = [persona.trim()];
  if (affect) parts.push(labels.affectHeader, affect);
  if (snapshot) parts.push(labels.memoryHeader, snapshot);
  parts.push(
    labels.summaryHeader,
    summary || labels.empty,
    labels.recentHeader,
    lines.length > 0 ? lines.join('\n') : labels.empty,
  );
  return parts.join('\n\n');
}

function clipHead(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `${s.slice(0, max - 1)}…`;
}

function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `…${s.slice(s.length - max + 1)}`;
}

export function buildInstructions(
  parts: InstructionParts,
  budget?: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): string {
  const lines = parts.recent.map((entry) => line(entry, labels));
  const affect = parts.affect ?? '';
  if (!budget) return render(parts.persona, affect, parts.memorySnapshot ?? '', parts.summary, lines, labels);
  let snapshot = clipHead(parts.memorySnapshot ?? '', budget.snapshotMaxChars);
  let summary = clipTail(parts.summary, budget.summaryMaxChars);
  const kept = [...lines];
  // The affect section is reserved in historyBudget, so it is never part of the clipping.
  const over = () => render(parts.persona, affect, snapshot, summary, kept, labels).length - budget.totalChars;
  while (over() > 0 && kept.length > 0) kept.shift();
  if (over() > 0) summary = clipTail(summary, Math.max(0, summary.length - over()));
  if (over() > 0) snapshot = clipHead(snapshot, Math.max(0, snapshot.length - over()));
  return render(parts.persona, affect, snapshot, summary, kept, labels);
}

/** Room left for summary plus recent turns after the persona, the full snapshot and the full affect section. */
export function historyBudget(
  persona: string,
  budget: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): number {
  const affectRoom = budget.affectMaxChars ?? 0;
  const affect = affectRoom > 0 ? 'x'.repeat(affectRoom) : '';
  return budget.totalChars - render(persona, affect, 'x'.repeat(budget.snapshotMaxChars), '', [], labels).length;
}
