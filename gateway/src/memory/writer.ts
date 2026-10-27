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

/** Outcome of one transcript write; messageId is set only when a row was stored. */
export interface AppendResult {
  result: 'stored' | 'skipped' | 'rejected';
  messageId?: string;
}

/** Persists one transcript turn. Implementations must not log the text. */
export interface TranscriptWriter {
  append(input: {
    ownerId: string;
    /** Server-side SessionContext agent; the store checks it belongs to ownerId. */
    agentId: string;
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    now: number;
    interrupted?: boolean;
  }): AppendResult;
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
    agentId: string;
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    now: number;
    interrupted?: boolean;
  }): AppendResult {
    const owner = this.store.getOwner(input.ownerId);
    if (!owner || owner.notifiedAt == null || owner.memoryConsent === 'declined') return { result: 'skipped' };
    const verdict = scanText(input.text, this.rules);
    if (verdict === 'reject') return { result: 'rejected' };
    // Caller already truncated an interrupted reply. Index the redacted text only.
    let text = redact(input.text);
    if (verdict === 'degrade') {
      text = stripDigits(text, this.digitChars);
      log('safety_event', { code: 'degrade' });
    }
    const messageId = randomUUID();
    this.store.insertMessage({
      id: messageId,
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      agentId: input.agentId,
      role: input.role,
      text,
      bigrams: bigrams(text),
      now: input.now,
    });
    if (verdict === 'degrade') {
      this.store.writeExtraction(input.ownerId, input.agentId, {
        now: input.now,
        messageIds: [],
        facts: [{ op: 'add', category: 'safety', text, sensitive: true }],
        notes: [],
        episodes: [],
        followups: [],
      });
    }
    return { result: 'stored', messageId };
  }

  markNotified(ownerId: string, now: number): void {
    this.store.markNotified(ownerId, now);
  }
}
