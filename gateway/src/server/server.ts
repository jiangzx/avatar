import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { FRAME_AI, FRAME_MIC, MIC_FRAME_SAMPLES, decodeAudioFrame, encodeAudioFrame } from '@anyidea/protocol';
import { log } from '../log.ts';
import type { SessionManager } from '../session/manager.ts';
import type { Transport } from '../session/session.ts';
import { safeEqual } from '../session/tokens.ts';
import { ResumeRequestSchema, parseClientMessage } from './schemas.ts';

export interface GatewayServerOptions {
  manager: SessionManager;
  appSecret: string;
  allowedOrigin: (origin: string) => boolean;
  allowDebugText: boolean;
  /** Uplink frames are 20 ms (50/s); allow bursts up to 2x. */
  maxFramesPerSecond?: number;
  /** WS ping interval; a socket silent for a whole interval (no pong, no message) is dropped. */
  heartbeatMs?: number;
}

export function createGatewayServer(opts: GatewayServerOptions): Server {
  const server = createServer((req, res) => {
    handleHttp(req, res, opts).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const claimed = opts.manager.claim(url.searchParams.get('token') ?? '');
    if (!claimed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bindConnection(ws, claimed.sessionId, claimed.connId, opts));
  });
  return server;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions): Promise<void> {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && opts.allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-app-secret');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  res.setHeader('Cache-Control', 'no-store');
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && path === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST') {
    json(res, 404, { error: 'not_found' });
    return;
  }
  const secret = req.headers['x-app-secret'];
  if (typeof secret !== 'string' || !safeEqual(secret, opts.appSecret)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  if (path === '/session') {
    json(res, 200, opts.manager.create());
    return;
  }
  if (path === '/session/resume') {
    const parsed = ResumeRequestSchema.safeParse(await readJson(req, 4096));
    if (!parsed.success) {
      json(res, 400, { error: 'bad_request' });
      return;
    }
    const tokens = opts.manager.resume(parsed.data.sessionId, parsed.data.resumeToken);
    if (!tokens) {
      json(res, 404, { error: 'session_gone' });
      return;
    }
    json(res, 200, tokens);
    return;
  }
  json(res, 404, { error: 'not_found' });
}

function bindConnection(ws: WebSocket, sessionId: string, connId: number, opts: GatewayServerOptions): void {
  const { manager } = opts;
  const maxFrames = opts.maxFramesPerSecond ?? 100;
  let begun = false;
  let frames = 0;
  let windowStart = Date.now();
  let alive = true;
  const transport: Transport = {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    sendAudio: (seq, pcm) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeAudioFrame(FRAME_AI, seq, pcm));
    },
  };
  manager.attachSocket(sessionId, connId, () => ws.terminate());
  const heartbeat = setInterval(() => {
    if (!alive) {
      log('ws_heartbeat_timeout', {});
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, opts.heartbeatMs ?? 10_000);
  ws.on('pong', () => {
    alive = true;
  });

  ws.on('message', (data, isBinary) => {
    alive = true;
    if (isBinary) {
      if (!begun) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        frames = 0;
      }
      if (++frames > maxFrames) return;
      const frame = decodeAudioFrame(toBytes(data));
      if (!frame || frame.kind !== FRAME_MIC || frame.pcm.length > 4 * MIC_FRAME_SAMPLES) return;
      manager.route(sessionId, connId)?.handleMicAudio(frame.pcm);
      return;
    }
    const msg = parseClientMessage(data.toString());
    if (!msg) {
      transport.send({ type: 'error', code: 'bad_message', retryable: false });
      return;
    }
    if (msg.type === 'session.start' || msg.type === 'session.resume') {
      if (begun) return;
      if (msg.type === 'session.resume' && msg.sessionId !== sessionId) {
        ws.close(4001, 'session_mismatch');
        return;
      }
      begun = true;
      manager
        .begin(sessionId, connId, msg.type === 'session.start' ? 'start' : 'resume', transport)
        .then((ok) => {
          if (!ok) ws.close(4002, 'bad_state');
        })
        .catch(() => {
          log('session_begin_failed', {});
          ws.close(1011, 'internal');
        });
      return;
    }
    if (!begun) return;
    if (msg.type === 'debug.userText' && !opts.allowDebugText) return;
    if (msg.type === 'session.end') {
      if (manager.route(sessionId, connId)) manager.end(sessionId);
      ws.close(1000);
      return;
    }
    manager.route(sessionId, connId)?.handleClientMessage(msg);
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    manager.disconnected(sessionId, connId); // ignored if this socket was superseded or the session ended
  });
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
