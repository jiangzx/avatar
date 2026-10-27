import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminError } from '@anyidea/protocol';

export const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Ant Design injects runtime <style> tags (CSS-in-JS).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', ADMIN_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { error, message } satisfies AdminError);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204).end();
}

/** JSON only. Returns null for a missing, non-JSON, oversized or unparsable body. */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(;|$)/i.test(type)) {
    req.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Browser writes must come from this origin. Non-browser clients send neither header. */
export function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // includes "null"
  }
}
