import { describe, expect, it } from 'vitest';
import { looksLikeFbx } from '../src/avatar/actions.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const FBX_HEAD = bytes('Kaydara FBX Binary  \0\x1a\0');

describe('looksLikeFbx', () => {
  it('rejects an SPA index.html fallback', () => {
    expect(looksLikeFbx('text/html; charset=utf-8', bytes('<!doctype html><html>'))).toBe(false);
    expect(looksLikeFbx(null, bytes('<!doctype html><html>'))).toBe(false);
  });

  it('accepts the FBX binary magic with a missing or generic content-type', () => {
    expect(looksLikeFbx(null, FBX_HEAD)).toBe(true);
    expect(looksLikeFbx('application/octet-stream', FBX_HEAD)).toBe(true);
  });

  it('rejects html content-type, truncated or empty bodies even near the magic', () => {
    expect(looksLikeFbx('TEXT/HTML', FBX_HEAD)).toBe(false);
    expect(looksLikeFbx('application/octet-stream', bytes('Kaydara'))).toBe(false);
    expect(looksLikeFbx('', new Uint8Array(0))).toBe(false);
  });
});
