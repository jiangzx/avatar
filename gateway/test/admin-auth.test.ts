import { describe, expect, it } from 'vitest';
import { ADMIN_COOKIE, clearedSessionCookie, readCookie, sessionCookie } from '../src/admin/cookies.ts';
import { LoginGuard } from '../src/admin/loginGuard.ts';
import { AdminSessionStore, SESSION_ID_PATTERN, csrfMatches } from '../src/admin/sessions.ts';

const MIN = 60_000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('AdminSessionStore', () => {
  it('creates distinct random ids and csrf tokens', () => {
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN });
    const a = store.create('admin');
    const b = store.create('admin');
    expect(a.id).toMatch(SESSION_ID_PATTERN);
    expect(a.csrfToken).toMatch(SESSION_ID_PATTERN);
    expect(a.id).not.toBe(b.id);
    expect(a.csrfToken).not.toBe(a.id);
    expect(store.size).toBe(2);
  });

  it('expires after idle time and slides on use', () => {
    const c = clock();
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN, now: c.now });
    const s = store.create('admin');
    c.advance(29 * MIN);
    expect(store.get(s.id)?.actor).toBe('admin');
    c.advance(29 * MIN); // 58 min since create, 29 since last use
    expect(store.get(s.id)).not.toBeNull();
    c.advance(31 * MIN);
    expect(store.get(s.id)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('expires at the absolute limit even when used', () => {
    const c = clock();
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 60 * MIN, now: c.now });
    const s = store.create('admin');
    for (let i = 0; i < 3; i++) {
      c.advance(20 * MIN);
      if (i < 2) expect(store.get(s.id)).not.toBeNull();
    }
    expect(store.get(s.id)).toBeNull();
  });

  it('reports the earlier of idle and absolute expiry', () => {
    const c = clock();
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 40 * MIN, now: c.now });
    const s = store.create('admin');
    expect(store.idleExpiresAt(s)).toBe(c.now() + 30 * MIN);
    c.advance(20 * MIN);
    const touched = store.get(s.id)!;
    expect(store.idleExpiresAt(touched)).toBe(1_000_000 + 40 * MIN);
  });

  it('ignores malformed and unknown ids, and destroys', () => {
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN });
    expect(store.get('')).toBeNull();
    expect(store.get('../../etc')).toBeNull();
    expect(store.get('A'.repeat(43))).toBeNull();
    const s = store.create('admin');
    store.destroy(s.id);
    expect(store.get(s.id)).toBeNull();
  });

  it('matches csrf tokens exactly', () => {
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN });
    const s = store.create('admin');
    expect(csrfMatches(s, s.csrfToken)).toBe(true);
    expect(csrfMatches(s, undefined)).toBe(false);
    expect(csrfMatches(s, '')).toBe(false);
    expect(csrfMatches(s, `${s.csrfToken}x`)).toBe(false);
    expect(csrfMatches(s, [s.csrfToken, s.csrfToken])).toBe(false);
  });
});

describe('LoginGuard', () => {
  it('locks a source after maxFailures within the window', () => {
    const c = clock();
    const guard = new LoginGuard({ maxFailures: 3, windowMs: 15 * MIN, lockMs: 15 * MIN, now: c.now });
    for (let i = 0; i < 3; i++) {
      expect(guard.check('1.1.1.1')).toEqual({ allowed: true });
      guard.fail('1.1.1.1');
    }
    expect(guard.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 15 * MIN });
    expect(guard.check('2.2.2.2')).toEqual({ allowed: true });
    c.advance(10 * MIN);
    expect(guard.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 5 * MIN });
    c.advance(5 * MIN);
    expect(guard.check('1.1.1.1')).toEqual({ allowed: true });
  });

  it('forgets failures older than the window', () => {
    const c = clock();
    const guard = new LoginGuard({ maxFailures: 3, windowMs: 15 * MIN, lockMs: 15 * MIN, now: c.now });
    guard.fail('a');
    guard.fail('a');
    c.advance(16 * MIN);
    guard.fail('a');
    expect(guard.check('a')).toEqual({ allowed: true });
  });

  it('clears the count on success', () => {
    const guard = new LoginGuard({ maxFailures: 2, windowMs: 15 * MIN, lockMs: 15 * MIN });
    guard.fail('a');
    guard.succeed('a');
    guard.fail('a');
    expect(guard.check('a')).toEqual({ allowed: true });
  });

  it('sweeps expired entries so the table stays bounded', () => {
    const c = clock();
    const guard = new LoginGuard({ maxFailures: 5, windowMs: MIN, lockMs: MIN, now: c.now });
    for (let i = 0; i < 300; i++) guard.fail(`src-${i}`);
    c.advance(2 * MIN);
    for (let i = 0; i < 256; i++) guard.check('fresh');
    expect(guard.size).toBeLessThanOrEqual(1);
  });
});

describe('cookies', () => {
  it('reads one cookie among several', () => {
    expect(readCookie('a=1; admin_sid=abc; b=2', ADMIN_COOKIE)).toBe('abc');
    expect(readCookie('admin_sid_x=1', ADMIN_COOKIE)).toBeNull();
    expect(readCookie(undefined, ADMIN_COOKIE)).toBeNull();
    expect(readCookie('admin_sid=', ADMIN_COOKIE)).toBeNull();
  });

  it('writes a strict, http-only, secure session cookie', () => {
    expect(sessionCookie('abc', 43_200_000)).toBe('admin_sid=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200');
    expect(clearedSessionCookie()).toBe('admin_sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  });
});
