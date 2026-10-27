export const ADMIN_COOKIE = 'admin_sid';
const ATTRS = 'HttpOnly; Secure; SameSite=Strict; Path=/';

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

export function sessionCookie(id: string, maxAgeMs: number): string {
  return `${ADMIN_COOKIE}=${id}; ${ATTRS}; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${ADMIN_COOKIE}=; ${ATTRS}; Max-Age=0`;
}
