import type { LedgerEntry } from './ledger.ts';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';

export interface InstructionBudget {
  totalChars: number;
  snapshotMaxChars: number;
  summaryMaxChars: number;
  /** Room reserved for the affect section; missing means 0. The section itself is never clipped. */
  affectMaxChars?: number;
  /** Room reserved for the pinned block; missing means 0. validateBudgets always sets it. Never clipped. */
  pinnedMaxChars?: number;
}

export interface InstructionParts {
  persona: string;
  /** Deterministic affect render (affectRender.ts); empty or missing leaves the section out. */
  affect?: string;
  /** Pinned memory block (renderMemoryViews().pinnedBlock). Rendered before the snapshot, never clipped. */
  pinned?: string;
  memorySnapshot?: string;
  summary: string;
  recent: readonly LedgerEntry[];
}

const line = (e: LedgerEntry, labels: PromptLabels) =>
  `${e.role === 'user' ? labels.user : labels.assistant}${labels.separator}${e.text}`;

function render(
  persona: string,
  affect: string,
  pinned: string,
  snapshot: string,
  summary: string,
  lines: readonly string[],
  labels: PromptLabels,
): string {
  const parts = [persona.trim()];
  if (affect) parts.push(labels.affectHeader, affect);
  // Pins and the snapshot share one memory header; pins come first.
  if (pinned || snapshot) parts.push(labels.memoryHeader);
  if (pinned) parts.push(pinned);
  if (snapshot) parts.push(snapshot);
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
  const pinned = parts.pinned ?? '';
  if (!budget) return render(parts.persona, affect, pinned, parts.memorySnapshot ?? '', parts.summary, lines, labels);
  let snapshot = clipHead(parts.memorySnapshot ?? '', budget.snapshotMaxChars);
  let summary = clipTail(parts.summary, budget.summaryMaxChars);
  const kept = [...lines];
  // Affect and pins are reserved in historyBudget, so they are never part of the clipping.
  const over = () => render(parts.persona, affect, pinned, snapshot, summary, kept, labels).length - budget.totalChars;
  while (over() > 0 && kept.length > 0) kept.shift();
  if (over() > 0) summary = clipTail(summary, Math.max(0, summary.length - over()));
  if (over() > 0) snapshot = clipHead(snapshot, Math.max(0, snapshot.length - over()));
  return render(parts.persona, affect, pinned, snapshot, summary, kept, labels);
}

/** Room left for summary plus recent turns after the persona, the full affect section, the full pinned block and the full snapshot. */
export function historyBudget(
  persona: string,
  budget: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): number {
  const affectRoom = budget.affectMaxChars ?? 0;
  const pinnedRoom = budget.pinnedMaxChars ?? 0;
  const affect = affectRoom > 0 ? 'x'.repeat(affectRoom) : '';
  const pinned = pinnedRoom > 0 ? 'x'.repeat(pinnedRoom) : '';
  return budget.totalChars - render(persona, affect, pinned, 'x'.repeat(budget.snapshotMaxChars), '', [], labels).length;
}
