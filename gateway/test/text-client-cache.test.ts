import { describe, expect, it } from 'vitest';
import { TextClientCache, switchingTextClient } from '../src/memory/textClientCache.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';

function fake(tag: string): TextModelClient {
  return { complete: async () => tag };
}

describe('TextClientCache', () => {
  it('reuses the client for the same key and replaces it for a new key', () => {
    const made: string[] = [];
    const cache = new TextClientCache((settings) => { made.push(settings.model); return fake(settings.model); });
    const a = cache.get('1:0', { apiKey: 'k', endpoint: 'https://e', model: 'qwen-plus' });
    expect(cache.get('1:0', { apiKey: 'k', endpoint: 'https://e', model: 'qwen-plus' })).toBe(a);
    const b = cache.get('2:0', { apiKey: 'k', endpoint: 'https://e', model: 'qwen-flash' });
    expect(b).not.toBe(a);
    expect(made).toEqual(['qwen-plus', 'qwen-flash']);
  });
});

describe('switchingTextClient', () => {
  it('resolves the target on every call', async () => {
    let current = fake('one');
    const client = switchingTextClient(() => current);
    const input = { system: 's', user: 'u', maxTokens: 8, signal: new AbortController().signal };
    expect(await client.complete(input)).toBe('one');
    current = fake('two');
    expect(await client.complete(input)).toBe('two');
  });
});
