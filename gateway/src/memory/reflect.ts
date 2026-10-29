import { z } from 'zod';
import type { SafetyRules } from '../config.ts';
import { normalizeForMatch } from './grounding.ts';
import { scanText } from './scan.ts';

export interface ReflectionItem { text: string; evidenceMessageIds: string[] }

const Reply = z.object({
  items: z.array(z.object({ text: z.string(), sources: z.array(z.string()).max(10) })).max(20),
});

/**
 * Keeps items grounded in this run's refs, within maxChars, new against `known`, and not rejected by the
 * safety rules, up to maxItems. Null when the reply is not the expected JSON.
 */
export function parseReflections(
  raw: string,
  refs: ReadonlyMap<string, string>,
  rules: { maxItems: number; maxChars: number; known: readonly string[]; safety?: SafetyRules },
): { items: ReflectionItem[]; dropped: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return null;
  }
  const parsed = Reply.safeParse(value);
  if (!parsed.success) return null;
  const seen = new Set(rules.known.map(normalizeForMatch));
  const items: ReflectionItem[] = [];
  let dropped = 0;
  for (const item of parsed.data.items) {
    const text = item.text.trim();
    const key = normalizeForMatch(text);
    const ids = [...new Set(item.sources.map((ref) => refs.get(ref)).filter((id): id is string => id !== undefined))];
    const ok = text.length > 0 && [...text].length <= rules.maxChars && key.length > 0 && !seen.has(key) && ids.length > 0
      && !(rules.safety && scanText(text, rules.safety) === 'reject') && items.length < rules.maxItems;
    if (!ok) {
      dropped++;
      continue;
    }
    seen.add(key);
    items.push({ text, evidenceMessageIds: ids });
  }
  return { items, dropped };
}
