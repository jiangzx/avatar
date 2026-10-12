import { describe, expect, it } from 'vitest';
import { ActionRouter, matchKeyword, parseActionArgs } from '../src/session/actions.ts';

describe('matchKeyword', () => {
  it.each([
    ['挥挥手', 'wave'], ['跟我招招手', 'wave'], ['和大家打个招呼', 'wave'],
    ['点点头', 'nod'], ['你点头呀', 'nod'],
    ['对我笑一下', 'smile'], ['笑一个', 'smile'], ['微笑', 'smile'],
    ['转个身', 'turn'], ['转一圈给我看', 'turn'], ['转过去', 'turn'],
    ['给我比个心', 'heart'], ['比心', 'heart'],
  ])('%s → %s', (text, action) => {
    expect(matchKeyword(text)).toBe(action);
  });

  it('returns null for ordinary talk', () => {
    expect(matchKeyword('今天天气不错')).toBeNull();
  });

  it('picks the earliest mention', () => {
    expect(matchKeyword('先点点头再挥挥手')).toBe('nod');
  });
});

describe('parseActionArgs', () => {
  it('accepts objects and JSON strings with a known action', () => {
    expect(parseActionArgs({ action: 'heart' })).toBe('heart');
    expect(parseActionArgs('{"action":"turn"}')).toBe('turn');
  });
  it('rejects unknown or malformed input', () => {
    expect(parseActionArgs({ action: 'dance' })).toBeNull();
    expect(parseActionArgs('not json')).toBeNull();
    expect(parseActionArgs(null)).toBeNull();
  });
});

describe('ActionRouter', () => {
  it('deduplicates the same action within the window across keyword and tool', () => {
    let t = 0;
    const r = new ActionRouter(3000, () => t);
    expect(r.fromKeyword('挥挥手')).toBe('wave');
    t = 1000;
    expect(r.fromTool({ action: 'wave' })).toEqual({ action: null, result: { ok: true } });
    t = 3500;
    expect(r.fromTool({ action: 'wave' })).toEqual({ action: 'wave', result: { ok: true } });
  });

  it('does not deduplicate different actions', () => {
    const r = new ActionRouter(3000, () => 0);
    expect(r.fromKeyword('挥挥手')).toBe('wave');
    expect(r.fromKeyword('比个心')).toBe('heart');
  });

  it('reports unsupported tool actions to the model', () => {
    const r = new ActionRouter();
    expect(r.fromTool({ action: 'fly' })).toEqual({ action: null, result: { ok: false, error: 'unsupported_action' } });
  });
});
