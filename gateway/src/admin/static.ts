import { lstat, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';

export const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, urlPath: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return plain(res, 400, '地址不正确。');
  }
  if (decoded.includes('\0')) return plain(res, 400, '地址不正确。');
  const base = resolve(root);
  let rel = normalize(decoded).replace(/^[/\\]+/, '');
  // Client-side routes have no extension: hand them the SPA shell.
  if (rel === '' || extname(rel) === '') rel = 'index.html';
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) return plain(res, 404, '没有这个页面。');
  const type = STATIC_TYPES[extname(abs).toLowerCase()];
  if (!type) return plain(res, 404, '没有这个页面。');
  let info;
  try {
    info = await lstat(abs);
  } catch {
    if (rel === 'index.html') return plain(res, 503, '后台前端还没有构建，请先运行 npm run build -w admin。');
    return plain(res, 404, '没有这个页面。');
  }
  // Untrusted symlinks could point outside the root.
  if (info.isSymbolicLink() || !info.isFile()) return plain(res, 404, '没有这个页面。');
  const body = await readFile(abs);
  const immutable = rel.startsWith(`assets${sep}`) || rel.startsWith('assets/');
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
