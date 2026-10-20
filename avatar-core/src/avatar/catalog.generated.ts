// Generated from scripts/avatar-catalog.json. Do not edit by hand.
export const AVATAR_CATALOG = [{"id":"default","title":"现有形象","description":"温和自然，陪您轻松聊天","assetPath":"./avatars/avatar.glb","body":"F"},{"id":"cute-girl","title":"可爱小女孩","description":"活泼亲切，带一点俏皮感","assetPath":"./avatars/cute-girl.glb","body":"F"},{"id":"cute-boy","title":"可爱小男孩","description":"阳光好奇，喜欢听您分享","assetPath":"./avatars/cute-boy.glb","body":"M"},{"id":"young-woman","title":"青年美女","description":"明亮从容，温柔有分寸","assetPath":"./avatars/young-woman.glb","body":"F"},{"id":"young-man","title":"青年俊男","description":"清爽可靠，聊天自然","assetPath":"./avatars/young-man.glb","body":"M"}] as const;
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
