import { describe, expect, it } from 'vitest';
import { ALLOWED_AVATAR_URLS, avatarBodyForUrl, DEFAULT_AVATAR_URL, normalizeAvatarUrl } from '../src/avatar/catalog.ts';

describe('avatar catalog', () => {
  it('keeps only the 小柔 model path', () => {
    expect(ALLOWED_AVATAR_URLS).toEqual(['./avatars/avatar.glb']);
    expect(ALLOWED_AVATAR_URLS.every((url) => url.startsWith('./avatars/') && url.endsWith('.glb'))).toBe(true);
  });

  it('normalizes omitted values to 小柔 and rejects retired or arbitrary paths', () => {
    expect(normalizeAvatarUrl(undefined)).toBe(DEFAULT_AVATAR_URL);
    expect(normalizeAvatarUrl('./avatars/avatar.glb')).toBe('./avatars/avatar.glb');
    for (const value of [null, 1, '', './avatars/cute-girl.glb', './avatars/../secret.glb', 'http://evil/avatar.glb', 'data:text/plain,x', './model.glb']) {
      expect(normalizeAvatarUrl(value)).toBeNull();
    }
  });

  it('uses the female body for 小柔 and for unknown paths', () => {
    expect(avatarBodyForUrl('./avatars/avatar.glb')).toBe('F');
    expect(avatarBodyForUrl('./avatars/cute-boy.glb')).toBe('F');
  });
});
