// Thread lifecycle retention (spec 事项线). A thread that can never be raised again is closed, which clears its quote.
import type { MemoryStore, ThreadRecord } from '../../memory/store.ts';
import type { ProactivityConfig } from './config.ts';

const DAY = 86_400_000;

export function threadExpired(thread: ThreadRecord, now: number, cfg: ProactivityConfig): boolean {
  const t = cfg.threads;
  if (thread.kind === 'event') return thread.mentionCount >= t.event.maxMentions || now - thread.dueAt > t.event.postDays * DAY;
  if (thread.kind === 'concern') return thread.mentionCount >= t.concern.maxMentions || now - thread.createdAt > t.concern.expireDays * DAY;
  return thread.mentionCount >= t.plan.maxMentions || now - thread.createdAt > t.plan.maxDays * DAY;
}

/** Daily job body for one owner. Returns how many threads were closed; one failing agent does not stop the rest. */
export function expireThreads(store: MemoryStore, ownerId: string, now: number, cfg: ProactivityConfig): number {
  let closed = 0;
  for (const agent of store.listAgents(ownerId)) {
    try {
      for (const thread of store.listOpenThreads(ownerId, agent.id)) {
        if (threadExpired(thread, now, cfg) && store.closeThread(ownerId, thread.id, 'expired', now)) closed += 1;
      }
    } catch {
      // The caller logs a content-free failure; the next night retries.
    }
  }
  return closed;
}
