import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

let dist = '';
let outside = '';
let h: AdminHarness | null = null;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'admin-static-'));
  dist = join(base, 'dist');
  outside = join(base, 'outside');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>后台</title>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'notes.txt'), 'not allowed');
  writeFileSync(join(outside, 'secret.js'), 'secret');
  symlinkSync(join(outside, 'secret.js'), join(dist, 'assets', 'link.js'));
});
afterAll(() => rmSync(join(dist, '..'), { recursive: true, force: true }));
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('admin static files', () => {
  it('serves index.html for / and for client routes', async () => {
    h = await bootAdmin({ staticDir: dist });
    for (const path of ['/', '/users', '/config/pacing']) {
      const res = await h.api(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toContain('后台');
    }
  });

  it('serves hashed assets with long cache', async () => {
    h = await bootAdmin({ staticDir: dist });
    const res = await h.api('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('refuses traversal, symlinks, unknown extensions and missing files', async () => {
    h = await bootAdmin({ staticDir: dist });
    expect((await h.api('/assets/..%2f..%2foutside%2fsecret.js')).status).toBe(404);
    expect((await h.api('/assets/link.js')).status).toBe(404);
    expect((await h.api('/notes.txt')).status).toBe(404);
    expect((await h.api('/assets/missing.js')).status).toBe(404);
    expect((await h.api('/%E0%A4%A')).status).toBe(400);
  });

  it('explains when the frontend is not built', async () => {
    h = await bootAdmin({ staticDir: join(dist, 'missing') });
    const res = await h.api('/');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm run build -w admin');
  });
});
