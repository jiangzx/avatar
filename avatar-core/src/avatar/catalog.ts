export const DEFAULT_AVATAR_URL = './avatars/avatar.glb';

export const ALLOWED_AVATAR_URLS = [
  DEFAULT_AVATAR_URL,
  './avatars/cute-girl.glb',
  './avatars/cute-boy.glb',
  './avatars/young-woman.glb',
  './avatars/young-man.glb',
] as const;

export type AvatarUrl = (typeof ALLOWED_AVATAR_URLS)[number];

export function avatarBodyForUrl(url: string): 'F' | 'M' {
  return url === './avatars/cute-boy.glb' || url === './avatars/young-man.glb' ? 'M' : 'F';
}

export function normalizeAvatarUrl(raw: unknown): AvatarUrl | null {
  if (raw === undefined) return DEFAULT_AVATAR_URL;
  if (typeof raw !== 'string') return null;
  return (ALLOWED_AVATAR_URLS as readonly string[]).includes(raw) ? (raw as AvatarUrl) : null;
}
