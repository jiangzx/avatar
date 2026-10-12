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

const OPEN = 1;

// TUNABLE: reconnect backoff (ms): base doubles per attempt up to the cap
export const RESUME_BACKOFF_BASE_MS = 500;
export const RESUME_BACKOFF_MAX_MS = 4000;
// TUNABLE: give up resuming after this long (must stay below gateway 60 s grace)
export const DEFAULT_MAX_RESUME_MS = 55_000;

export class GatewayClient {
  private ws: WebSocketLike | null = null;
  private tokens: SessionTokens | null = null;
  private closedByUser = false;
  private disconnectedAt = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly o: GatewayClientOptions,
    private readonly ev: GatewayClientEvents,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  async start(): Promise<void> {
    this.closedByUser = false;
    this.tokens = await this.post('/session', {});
    this.open('session.start');
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(m));
  }

  sendAudio(pcm16k: Int16Array): void {
    if (this.ws?.readyState === OPEN) this.ws.send(encodeAudioFrame(FRAME_MIC, 0, pcm16k));
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.send({ type: 'session.end' });
    this.ws?.close(1000);
  }

  private open(first: 'session.start' | 'session.resume'): void {
    const t = this.tokens;
    if (!t) return;
    const Ctor = this.o.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
    const url = `${this.o.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(t.connectToken)}`;
    const ws = new Ctor(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.ev.onStatus(first === 'session.start' ? 'connecting' : 'reconnecting');
    ws.onopen = () => {
      this.attempt = 0;
      this.disconnectedAt = 0;
      this.ev.onStatus('open');
      this.send(first === 'session.start' ? { type: 'session.start', clientInfo: this.o.clientInfo } : { type: 'session.resume', sessionId: t.sessionId });
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        this.ev.onMessage(JSON.parse(e.data) as ServerMessage);
        return;
      }
      if (e.data instanceof ArrayBuffer) {
        const frame = decodeAudioFrame(new Uint8Array(e.data));
        if (frame && frame.kind === FRAME_AI) this.ev.onAudio(frame.responseSeq, frame.pcm);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) {
        this.ev.onStatus('closed');
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
      this.open('session.resume');
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 401)) await this.restartFresh();
      else this.scheduleResume();
    }
  }

  private async restartFresh(): Promise<void> {
    if (this.closedByUser) return;
    this.attempt = 0;
    try {
      this.tokens = await this.post('/session', {});
      this.disconnectedAt = 0;
      this.open('session.start');
    } catch {
      this.disconnectedAt = Date.now();
      this.scheduleResume();
    }
  }

  private async post(path: string, body: unknown): Promise<SessionTokens> {
    const fetchFn = this.o.fetchFn ?? fetch;
    const res = await fetchFn(`${this.o.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-secret': this.o.appSecret },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as SessionTokens;
  }
}
