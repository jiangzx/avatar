import { describe, expect, it } from 'vitest';
import source from '../characters.json' with { type: 'json' };
import {
  CHARACTER_IDS,
  DEFAULT_CHARACTER_ID,
  isCharacterId,
  type CharacterId,
  type ClientMessage,
  type MemoryClearScope,
  type MemoryOverview,
  type ResponseKind,
  type SessionCreateRequest,
} from '../src/index.ts';

describe('character ids', () => {
  it('come from protocol/characters.json in display order', () => {
    expect([...CHARACTER_IDS]).toEqual(source.ids);
    expect(DEFAULT_CHARACTER_ID).toBe(source.defaultId);
    expect([...CHARACTER_IDS]).toEqual(['xiaonuan', 'xiaokai', 'xiaoxin']);
    expect(DEFAULT_CHARACTER_ID).toBe('xiaonuan');
  });

  it('accepts only registered ids', () => {
    for (const id of CHARACTER_IDS) expect(isCharacterId(id)).toBe(true);
    for (const bad of ['lily', 'kai', 'default', '', 'XIAONUAN', ' xiaonuan', 42, null, undefined, {}, ['xiaonuan']]) {
      expect(isCharacterId(bad)).toBe(false);
    }
  });

  it('narrows unknown input to CharacterId', () => {
    const raw: unknown = 'xiaokai';
    if (!isCharacterId(raw)) throw new Error('expected a character id');
    const id: CharacterId = raw;
    expect(id).toBe('xiaokai');
  });
});

describe('multi-character protocol shapes', () => {
  it('adds the reminder response kind', () => {
    const kinds: ResponseKind[] = ['reply', 'greeting', 'followup', 'reminder'];
    expect(kinds).toHaveLength(4);
  });

  it('types the POST /session body with an optional character', () => {
    const chosen: SessionCreateRequest = { character: 'xiaokai' };
    const fallback: SessionCreateRequest = {};
    expect(chosen.character).toBe('xiaokai');
    expect(fallback.character).toBeUndefined();
  });

  it('types the memory overview returned by GET /memory', () => {
    const scope: MemoryClearScope = 'character';
    const overview: MemoryOverview = {
      profile: { addressing: { id: 'p1', text: '王叔' }, items: [{ id: 'p2', text: '老家山东' }] },
      characters: [
        { character: 'xiaonuan', pinned: [{ id: 'k1', text: '孙子三月三号生日', sensitive: false }], facts: [{ id: 'f1', text: '膝盖不好', category: 'health', sensitive: true }] },
        { character: 'xiaokai', pinned: [], facts: [] },
        { character: 'xiaoxin', pinned: [], facts: [] },
      ],
    };
    expect(scope).toBe('character');
    expect(overview.characters.map((entry) => entry.character)).toEqual([...CHARACTER_IDS]);
  });

  it('no longer accepts voiceProfile on session.start (checked by typecheck)', () => {
    const start: ClientMessage = {
      type: 'session.start',
      // @ts-expect-error voiceProfile was removed: the voice now follows the character card.
      clientInfo: { platform: 'android', audioPath: 'B', voiceProfile: 'young-male' },
    };
    expect(start.type).toBe('session.start');
  });
});
