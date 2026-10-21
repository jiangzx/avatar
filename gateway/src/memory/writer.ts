import { randomUUID } from 'node:crypto';
import type { SafetyRules } from '../config.ts';
import { DEFAULT_I18N } from '../i18n/load.ts';
import { log } from '../log.ts';
import { bigrams } from './bigram.ts';
import { redact } from './redact.ts';
import { scanText } from './scan.ts';
import type { MemoryStore } from './store.ts';

/** Removes ASCII digits and the Chinese digits listed in the safety rules. */
function stripDigits(text: string, digitChars: ReadonlySet<string>): string {
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
  private readonly digitChars: ReadonlySet<string>;

  constructor(
    private readonly store: MemoryStore,
    private readonly rules: SafetyRules = DEFAULT_I18N.safety,
  ) {
    this.digitChars = new Set(Object.keys(rules.chineseDigits));
  }

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
    const verdict = scanText(input.text, this.rules);
    if (verdict === 'reject') return 'rejected';
    // Caller already truncated an interrupted reply. Index the redacted text only.
    let text = redact(input.text);
    if (verdict === 'degrade') {
      text = stripDigits(text, this.digitChars);
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
