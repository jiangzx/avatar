import { bigrams } from './bigram.ts';
import type { MemoryStore } from './store.ts';

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** One bounded pass; rows already carrying kana tokens are skipped. */
export function backfillKanaBigrams(store: MemoryStore, limit: number): number {
  let changed = 0;
  for (const row of store.listMessagesForKanaBackfill(limit)) {
    if (!KANA.test(row.text) || KANA.test(row.bigrams)) continue;
    store.updateMessageBigrams(row.rowid, bigrams(row.text));
    changed++;
  }
  return changed;
}
