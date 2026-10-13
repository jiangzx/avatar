import {
  FRAME_AI,
  FRAME_MIC,
  decodeAudioFrame,
  encodeAudioFrame,
  type AudioPath,
  type ClientMessage,
  type ServerMessage,
  type SessionTokens,
} from '@anyidea/protocol';

export interface WebSocketLike {
  readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;
export type ClientStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface GatewayClientOptions {
  baseUrl: string;
  appSecret: string;
  clientInfo: { platform: string; audioPath: AudioPath };
  fetchFn?: typeof fetch;
  WebSocketCtor?: WebSocketCtor;
  /** Must stay below the gateway grace period (60 s). */
  maxResumeMs?: number;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export interface GatewayClientEvents {
  onMessage(m: ServerMessage): void;
  onAudio(seq: number, pcm: Int16Array): void;
  onStatus(s: ClientStatus): void;
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`http_${status}`);
  }
}

export class GatewayRequestTimeoutError extends Error {
  constructor() {
    super('gateway_request_timeout');
  }
}

const OPEN = 1;

// TUNABLE: reconnect backoff (ms): base doubles per attempt up to the cap
export const RESUME_BACKOFF_BASE_MS = 500;
export const RESUME_BACKOFF_MAX_MS = 4000;
// TUNABLE: give up resuming after this long (must stay below gateway 60 s grace)
export const DEFAULT_MAX_RESUME_MS = 55_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;

export class GatewayClient {
  private ws: WebSocketLike | null = null;
  private tokens: SessionTokens | null = null;
  private closedByUser = false;
  // True once the gateway confirmed the session (session.ready / session.resumed).
  private sessionStarted = false;
  private disconnectedAt = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closedEmitted = false;

  constructor(
    private readonly o: GatewayClientOptions,
    private readonly ev: GatewayClientEvents,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  async start(): Promise<void> {
    this.closedByUser = false;
    this.closedEmitted = false;
    this.sessionStarted = false;
    this.retryTimer = null;
    this.tokens = await this.post('/session', {});
    if (this.closedByUser) return;
    this.open('session.start');
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(m));
  }

  sendAudio(pcm16k: Int16Array): void {
    if (this.ws?.readyState === OPEN) this.ws.send(encodeAudioFrame(FRAME_MIC, 0, pcm16k));
  }

  close(): void {
    if (this.closedByUser) return;
    this.closedByUser = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.send({ type: 'session.end' });
    if (this.ws) this.ws.close(1000);
    else this.emitClosed();
  }

  private open(first: 'session.start' | 'session.resume'): void {
    const t = this.tokens;
    if (!t) return;
    const Ctor = this.o.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
    const url = `${this.o.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(t.connectToken)}`;
    const ws = new Ctor(url);
    ws.binaryType = 'arraybuffer';
    const previous = this.ws;
    this.ws = ws;
    previous?.close(1000);
    let socketTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== OPEN && !this.closedByUser) ws.close(1000);
    }, this.o.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS);
    const clearSocketTimer = () => {
      if (socketTimer) clearTimeout(socketTimer);
      socketTimer = null;
    };
    this.ev.onStatus(first === 'session.start' ? 'connecting' : 'reconnecting');
    ws.onopen = () => {
      if (this.ws !== ws || this.closedByUser) return;
      clearSocketTimer();
      this.ev.onStatus('open');
      this.send(first === 'session.start' ? { type: 'session.start', clientInfo: this.o.clientInfo } : { type: 'session.resume', sessionId: t.sessionId });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || this.closedByUser) return;
      if (typeof e.data === 'string') {
        let raw: unknown;
        try {
          raw = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
        const m = raw as ServerMessage;
        // Reset backoff only once the gateway accepted the session, not on mere socket open.
        if (m.type === 'session.ready' || m.type === 'session.resumed') {
          this.sessionStarted = true;
          this.attempt = 0;
          this.disconnectedAt = 0;
        }
        this.ev.onMessage(m);
        return;
      }
      if (e.data instanceof ArrayBuffer) {
        const frame = decodeAudioFrame(new Uint8Array(e.data));
        if (frame && frame.kind === FRAME_AI) this.ev.onAudio(frame.responseSeq, frame.pcm);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearSocketTimer();
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) {
        this.emitClosed();
        return;
      }
      if (!this.disconnectedAt) this.disconnectedAt = Date.now();
      this.scheduleResume();
    };
  }

  private scheduleResume(): void {
    if (this.closedByUser) return;
    if (Date.now() - this.disconnectedAt > (this.o.maxResumeMs ?? DEFAULT_MAX_RESUME_MS)) {
      void this.restartFresh();
      return;
    }
    const delay = Math.min(RESUME_BACKOFF_MAX_MS, RESUME_BACKOFF_BASE_MS * 2 ** this.attempt++);
    this.ev.onStatus('reconnecting');
    this.retryTimer = setTimeout(() => void this.tryResume(), delay);
  }

  private async tryResume(): Promise<void> {
    if (this.closedByUser || !this.tokens) return;
    try {
      this.tokens = await this.post('/session/resume', { sessionId: this.tokens.sessionId, resumeToken: this.tokens.resumeToken });
      if (this.closedByUser) return;
      // A session that never started must be started, not resumed (gateway would close 4002).
      this.open(this.sessionStarted ? 'session.resume' : 'session.start');
    } catch (e) {
      if (this.closedByUser) return;
      if (e instanceof HttpError && (e.status === 404 || e.status === 401)) await this.restartFresh();
      else this.scheduleResume();
    }
  }

  private async restartFresh(): Promise<void> {
    if (this.closedByUser) return;
    this.attempt = 0;
    this.sessionStarted = false;
    try {
      this.tokens = await this.post('/session', {});
      if (this.closedByUser) return;
      this.disconnectedAt = 0;
      this.open('session.start');
    } catch {
      if (this.closedByUser) return;
      this.disconnectedAt = Date.now();
      this.scheduleResume();
    }
  }

  private async post(path: string, body: unknown): Promise<SessionTokens> {
    const fetchFn = this.o.fetchFn ?? fetch;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${this.o.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-secret': this.o.appSecret },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new HttpError(res.status);
      return (await res.json()) as SessionTokens;
    } catch (error) {
      if (timedOut) throw new GatewayRequestTimeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private emitClosed(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.ev.onStatus('closed');
  }
}
