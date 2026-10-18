import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSafetyConfig } from '../config.ts';
import { log } from '../log.ts';
import { bigrams } from './bigram.ts';
import { redact } from './redact.ts';
import { scanText } from './scan.ts';
import type { MemoryStore } from './store.ts';

const rules = loadSafetyConfig(fileURLToPath(new URL('../../config/safety.json', import.meta.url)));
const digitChars = new Set(Object.keys(rules.chineseDigits));

/** Removes ASCII digits and the Chinese digits listed in safety.json. */
function stripDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    if ((ch >= '0' && ch <= '9') || digitChars.has(ch)) continue;
    out += ch;
  }
  return out;
}

/** Persists one transcript turn. Implementations must not log the text. */
export interface TranscriptWriter {
  append(input: {
    ownerId: string;
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    now: number;
    interrupted?: boolean;
  }): 'stored' | 'skipped' | 'rejected';
  /** Records that the memory notice finished playing. */
  markNotified(ownerId: string, now: number): void;
}

export class SqliteTranscriptWriter implements TranscriptWriter {
  constructor(private readonly store: MemoryStore) {}

  append(input: {
    ownerId: string;
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    now: number;
    interrupted?: boolean;
  }): 'stored' | 'skipped' | 'rejected' {
    const owner = this.store.getOwner(input.ownerId);
    if (!owner || owner.notifiedAt == null || owner.memoryConsent === 'declined') return 'skipped';
    const verdict = scanText(input.text, rules);
    if (verdict === 'reject') return 'rejected';
    // Caller already truncated an interrupted reply. Index the redacted text only.
    let text = redact(input.text);
    if (verdict === 'degrade') {
      text = stripDigits(text);
      log('safety_event', { code: 'degrade' });
    }
    this.store.insertMessage({
      id: randomUUID(),
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      role: input.role,
      text,
      bigrams: bigrams(text),
      now: input.now,
    });
    if (verdict === 'degrade') {
      this.store.writeExtraction(input.ownerId, {
        now: input.now,
        messageIds: [],
        facts: [{ op: 'add', category: 'safety', text, sensitive: true }],
        notes: [],
        episodes: [],
        followups: [],
      });
    }
    return 'stored';
  }

  markNotified(ownerId: string, now: number): void {
    this.store.markNotified(ownerId, now);
  }
}
