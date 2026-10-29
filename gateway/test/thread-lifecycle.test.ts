import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryStore, ThreadRecord } from '../src/memory/store.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { expireThreads, threadExpired } from '../src/session/proactive/lifecycle.ts';

const cfg = loadProactivity(fileURLToPath(new URL('../config/proactivity.json', import.meta.url)));
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T03:00:00+08:00');
const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '最近总睡不踏实。', dueAt: NOW, sensitive: false, mentionCount: 0,
  lastMentionedAt: null, createdAt: NOW - DAY, sourceSessionId: 's1', ...over,
});

describe('threadExpired', () => {
  it('keeps a concern for expireDays (14), not the old 7-day care window', () => {
    expect(threadExpired(thread({ createdAt: NOW - 8 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ createdAt: NOW - 15 * DAY }), NOW, cfg)).toBe(true);
    expect(threadExpired(thread({ mentionCount: cfg.threads.concern.maxMentions }), NOW, cfg)).toBe(true);
  });

  it('keeps an event said long before its date until postDays after it', () => {
    expect(threadExpired(thread({ kind: 'event', createdAt: NOW - 20 * DAY, dueAt: NOW + 2 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ kind: 'event', dueAt: NOW - 6 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ kind: 'event', dueAt: NOW - 8 * DAY }), NOW, cfg)).toBe(true);
    expect(threadExpired(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: cfg.threads.event.maxMentions }), NOW, cfg)).toBe(true);
  });

  it('keeps a plan until maxDays', () => {
    expect(threadExpired(thread({ kind: 'plan', createdAt: NOW - 7 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ kind: 'plan', createdAt: NOW - 8 * DAY }), NOW, cfg)).toBe(true);
    expect(threadExpired(thread({ kind: 'plan', createdAt: NOW - 4 * DAY, mentionCount: 1 }), NOW, cfg)).toBe(true);
  });
});

describe('expireThreads', () => {
  it('closes only expired threads, per agent, and survives one failing agent', () => {
    const closeThread = vi.fn(() => true);
    const store = {
      listAgents: vi.fn(() => [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]),
      listOpenThreads: vi.fn((_o: string, agentId: string) => {
        if (agentId === 'a2') throw new Error('sqlite_busy');
        return agentId === 'a1'
          ? [thread({ id: 'old', createdAt: NOW - 15 * DAY }), thread({ id: 'fresh' })]
          : [thread({ id: 'done', kind: 'plan', createdAt: NOW - 4 * DAY, mentionCount: 1 })];
      }),
      closeThread,
    } as unknown as MemoryStore;
    expect(expireThreads(store, 'o1', NOW, cfg)).toBe(2);
    expect(closeThread).toHaveBeenCalledWith('o1', 'old', 'expired', NOW);
    expect(closeThread).toHaveBeenCalledWith('o1', 'done', 'expired', NOW);
    expect(closeThread).not.toHaveBeenCalledWith('o1', 'fresh', 'expired', NOW);
  });
});
