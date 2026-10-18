import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSafetyConfig } from '../config.ts';
import { bigrams } from './bigram.ts';
import { redact } from './redact.ts';
import { scanText } from './scan.ts';
import type { MemoryStore } from './store.ts';

const rules = loadSafetyConfig(fileURLToPath(new URL('../../config/safety.json', import.meta.url)));

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
    if (scanText(input.text, rules) === 'reject') return 'rejected';
    // Caller already truncated an interrupted reply. Index the redacted text only.
    const text = redact(input.text);
    this.store.insertMessage({
      id: randomUUID(),
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      role: input.role,
      text,
      bigrams: bigrams(text),
      now: input.now,
    });
    return 'stored';
  }
}
