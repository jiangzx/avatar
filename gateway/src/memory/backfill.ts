import { bigrams } from './bigram.ts';
import type { MemoryStore } from './store.ts';

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * One bounded pass after the persisted cursor. A full page advances the cursor; a short page
 * wraps it to 0 so later startups rescan for rows that were already correct or newly written.
 */
export function backfillKanaBigrams(store: MemoryStore, limit: number): number {
  const rows = store.listMessagesForKanaBackfill(limit, store.kanaBackfillCursor());
  let changed = 0;
  for (const row of rows) {
    if (!KANA.test(row.text)) continue;
    const next = bigrams(row.text);
    if (next === row.bigrams) continue;
    store.updateMessageBigrams(row.rowid, next);
    changed++;
  }
  store.setKanaBackfillCursor(rows.length < limit ? 0 : rows[rows.length - 1]!.rowid);
  return changed;
}
