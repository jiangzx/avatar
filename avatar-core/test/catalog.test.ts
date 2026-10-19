import { describe, expect, it } from 'vitest';
import { ALLOWED_AVATAR_URLS, avatarBodyForUrl, DEFAULT_AVATAR_URL, normalizeAvatarUrl } from '../src/avatar/catalog.ts';

describe('avatar catalog', () => {
  it('keeps exactly the five relative model paths', () => {
    expect(ALLOWED_AVATAR_URLS).toEqual([
      './avatars/avatar.glb',
      './avatars/cute-girl.glb',
      './avatars/cute-boy.glb',
      './avatars/young-woman.glb',
      './avatars/young-man.glb',
    ]);
    expect(ALLOWED_AVATAR_URLS.every((url) => url.startsWith('./avatars/') && url.endsWith('.glb'))).toBe(true);
  });

  it('normalizes omitted values to the existing model and rejects arbitrary paths', () => {
    expect(normalizeAvatarUrl(undefined)).toBe(DEFAULT_AVATAR_URL);
    expect(normalizeAvatarUrl('./avatars/cute-girl.glb')).toBe('./avatars/cute-girl.glb');
    for (const value of [null, 1, '', './avatars/../secret.glb', 'http://evil/avatar.glb', 'data:text/plain,x', './model.glb']) {
      expect(normalizeAvatarUrl(value)).toBeNull();
    }
  });

  it('selects the matching TalkingHead body for gendered assets', () => {
    expect(avatarBodyForUrl('./avatars/cute-boy.glb')).toBe('M');
    expect(avatarBodyForUrl('./avatars/young-man.glb')).toBe('M');
    expect(avatarBodyForUrl('./avatars/cute-girl.glb')).toBe('F');
    expect(avatarBodyForUrl('./avatars/young-woman.glb')).toBe('F');
  });
});
