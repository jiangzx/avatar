import { describe, expect, it } from 'vitest';
import type { AdminLogLevelState, AdminMe, AdminOverview, AdminPage, AdminSessionRow, AdminTimeline } from '../src/index.ts';

describe('admin api types', () => {
  it('describe the agreed shapes', () => {
    const me = { actor: 'admin', csrfToken: 'x', idleExpiresAt: 1 } satisfies AdminMe;
    const overview = {
      range: 'today',
      brief: { owners: 1, callMinutes: 2, costMicroYuan: 3, errors: 0, deltaMinutesVsPrev: -1 },
      days: [{ day: '2026-10-27', owners: 1, callMinutes: 2, tokens: 10, costMicroYuan: 3, errors: 0 }],
      byKind: [{ kind: 'realtime_reply', costMicroYuan: 3, share: 1 }],
      latency: { firstAudioP50Ms: null, firstAudioP95Ms: null },
      alerts: [{ code: 'error_rate_1h', value: 0.2, threshold: 0.1 }],
      adapter: 'qwen',
    } satisfies AdminOverview;
    const session = {
      sid: 's', oid: 'o', character: 'xiaonuan', adapter: 'qwen', startedAt: 1, endedAt: null, endReason: null,
      replies: 0, errors: 0, firstAudioP50Ms: null, usage: { tokens: 0, costMicroYuan: 0, unpricedCalls: 0 },
    } satisfies AdminSessionRow;
    const timeline = { session, items: [{ ts: 1, level: 'info', event: 'response_start', seq: 1, fields: { kind: 'reply' } }], firstAudioAlertMs: 2000 } satisfies AdminTimeline;
    const page = { items: [session], nextCursor: null } satisfies AdminPage<AdminSessionRow>;
    const levels = { global: 'info', overrides: [{ scope: 'owner', oid: 'abc', level: 'debug', until: 2 }] } satisfies AdminLogLevelState;
    expect([me, overview, timeline, page, levels].length).toBe(5);
  });
});
