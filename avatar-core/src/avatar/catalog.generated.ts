// Generated from scripts/avatar-catalog.json. Do not edit by hand.
export const AVATAR_CATALOG = [{"id":"default","title":"小柔","description":"温和自然，陪您轻松聊天","assetPath":"./avatars/avatar.glb","body":"F"}] as const;
export const DEFAULT_AVATAR_URL: string = AVATAR_CATALOG.find((option) => option.id === "default")!.assetPath;
export const ALLOWED_AVATAR_URLS = AVATAR_CATALOG.map(({ assetPath }) => assetPath);
export type AvatarUrl = (typeof AVATAR_CATALOG)[number]['assetPath'];
export function avatarBodyForUrl(url: string): 'F' | 'M' {
  return AVATAR_CATALOG.find((option) => option.assetPath === url)?.body ?? 'F';
}
export function normalizeAvatarUrl(raw: unknown): AvatarUrl | null {
  if (raw === undefined) return DEFAULT_AVATAR_URL as AvatarUrl;
  if (typeof raw !== 'string') return null;
  return (ALLOWED_AVATAR_URLS as readonly string[]).includes(raw) ? raw as AvatarUrl : null;
}
