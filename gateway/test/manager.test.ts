import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../src/session/context.ts';
import { SessionManager, type SessionLifecycle } from '../src/session/manager.ts';
import type { Session, TranscriptWriter, Transport } from '../src/session/session.ts';

const transport: Transport = { send: () => {}, sendAudio: () => {} };
const owned = (ownerId: string): SessionContext => ({ ownerId, agentId: `agent-${ownerId}`, roleId: 'elder-companion', styleId: 'grandchild' });
const dev: SessionContext = { roleId: 'elder-companion', styleId: 'grandchild' };

function fakeSession() {
  return {
    start: vi.fn(async () => {}),
    end: vi.fn(),
    attachTransport: vi.fn(),
    detachTransport: vi.fn(),
    flush: vi.fn(),
  };
}

let manager: SessionManager | null = null;

function setup(lifecycle?: SessionLifecycle) {
  const made: Array<ReturnType<typeof fakeSession>> = [];
  const events: string[] = [];
  const hook: SessionLifecycle = lifecycle ?? {
    started: (_id, ctx) => events.push(`started:${ctx.ownerId ?? 'dev'}`),
    ended: (_id, ctx, reason) => events.push(`ended:${ctx.ownerId ?? 'dev'}:${reason}`),
  };
  manager = new SessionManager(() => {
    const s = fakeSession();
    made.push(s);
    return s as unknown as Session;
  }, 60_000, 300_000, 10_000, hook);
  return { manager, made, events };
}

async function startNew(m: SessionManager, ctx: SessionContext) {
  const t = m.create(ctx);
  const claim = m.claim(t.connectToken)!;
  expect(await m.begin(t.sessionId, claim.connId, 'start', transport)).toBe(true);
  return { t, claim };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  manager?.shutdown();
  manager = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionManager owner invariant', () => {
  it('ends the previous session of the same owner, including one in its grace period', async () => {
    const { manager: m, made, events } = setup();
    const first = await startNew(m, owned('o1'));
    m.disconnected(first.t.sessionId, first.claim.connId); // now in grace
    m.create(owned('o1'));
    expect(made[0]!.end).toHaveBeenCalledOnce();
    expect(m.size).toBe(1);
    expect(events).toEqual(['started:o1', 'ended:o1:owner_replaced']);
    expect(m.resume(first.t.sessionId, first.t.resumeToken)).toBeNull();
  });

  it('drops the live socket of a replaced session', async () => {
    const { manager: m } = setup();
    const first = await startNew(m, owned('o1'));
    const terminate = vi.fn();
    m.attachSocket(first.t.sessionId, first.claim.connId, terminate);
    m.create(owned('o1'));
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('also replaces a session that was never claimed', () => {
    const { manager: m, made, events } = setup();
    m.create(owned('o1'));
    m.create(owned('o1'));
    expect(made[0]!.end).toHaveBeenCalledOnce();
    expect(m.size).toBe(1);
    expect(events).toEqual([]); // never started: nothing to record
  });

  it('leaves other owners and dev sessions alone', async () => {
    const { manager: m, made } = setup();
    await startNew(m, owned('o1'));
    await startNew(m, owned('o2'));
    await startNew(m, dev);
    await startNew(m, dev);
    m.create(owned('o1'));
    expect(m.size).toBe(4);
    expect(made.map((s) => s.end.mock.calls.length)).toEqual([1, 0, 0, 0, 0]);
  });

  it('flushes the previous session before destroying it', () => {
    const writer = { append: vi.fn<TranscriptWriter['append']>(() => 'stored') };
    const made: Array<ReturnType<typeof fakeSession>> = [];
    manager = new SessionManager((ctx, sessionId) => {
      const s = fakeSession();
      s.flush.mockImplementation(() => {
        writer.append({
          ownerId: ctx.ownerId ?? '',
          sessionId,
          role: 'assistant',
          text: 'kept',
          now: 1,
        });
      });
      made.push(s);
      return s as unknown as Session;
    }, 60_000, 300_000, 10_000);
    const first = manager.create(owned('o1'));
    manager.create(owned('o1'));
    const previous = made[0]!;
    expect(previous.flush).toHaveBeenCalledTimes(2);
    expect(previous.flush.mock.invocationCallOrder[0]).toBeLessThan(previous.end.mock.invocationCallOrder[0]!);
    expect(previous.flush.mock.invocationCallOrder[1]).toBeLessThan(previous.end.mock.invocationCallOrder[0]!);
    expect(writer.append).toHaveBeenCalledWith({
      ownerId: 'o1',
      sessionId: first.sessionId,
      role: 'assistant',
      text: 'kept',
      now: 1,
    });
    expect(made[1]!.flush).not.toHaveBeenCalled();
  });

  it('flushes before destroy when the client ends the session', async () => {
    const { manager: m, made } = setup();
    const started = await startNew(m, owned('o1'));
    m.end(started.t.sessionId);
    const session = made[0]!;
    expect(session.flush).toHaveBeenCalledOnce();
    expect(session.flush.mock.invocationCallOrder[0]).toBeLessThan(session.end.mock.invocationCallOrder[0]!);
  });

  it('endOwner ends every session of that owner and returns the count', async () => {
    const { manager: m, events } = setup();
    await startNew(m, owned('o1'));
    await startNew(m, owned('o2'));
    expect(m.endOwner('o1', 'owner_deleted')).toBe(1);
    expect(m.endOwner('o1', 'owner_deleted')).toBe(0);
    expect(m.size).toBe(1);
    expect(events).toContain('ended:o1:owner_deleted');
  });
});

describe('SessionManager lifecycle hook', () => {
  it('reports start and end only for started sessions', async () => {
    const { manager: m, events } = setup();
    m.create(owned('o1')); // unclaimed
    const started = await startNew(m, owned('o2'));
    m.end(started.t.sessionId);
    vi.advanceTimersByTime(300_000); // the unclaimed one expires
    expect(events).toEqual(['started:o2', 'ended:o2:client_end']);
    expect(m.size).toBe(0);
  });

  it('calls extract on end without waiting for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const { manager: m } = setup({
      started: () => events.push('started'),
      ended: () => events.push('ended'),
      extract: () => {
        events.push('extract');
        void gate.then(() => events.push('done'));
      },
    });
    const started = await startNew(m, owned('o1'));
    m.end(started.t.sessionId);
    expect(events).toEqual(['started', 'ended', 'extract']);
    release();
    await Promise.resolve();
    expect(events).toEqual(['started', 'ended', 'extract', 'done']);
  });

  it('keeps sessions working when the hook throws', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { manager: m } = setup({
      started: () => { throw new Error('db down'); },
      ended: () => { throw new Error('db down'); },
    });
    const s = await startNew(m, owned('o1'));
    expect(() => m.end(s.t.sessionId)).not.toThrow();
    const logged = write.mock.calls.map((c) => String(c[0])).join('');
    expect(logged.match(/session_lifecycle_failed/g)).toHaveLength(2);
    expect(logged).not.toContain('db down');
  });
});
