# Plan 3 Task 0: Shared Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the gateway-internal contracts that Plan A (persona and pacing) and Plan B (identity and binding) both depend on, with stub implementations, so the two plans can run in parallel without editing each other's files.

**Architecture:** The Director emits a structured `ProactiveRequest` (`cue`, `instruction`, `fallbackText`) instead of a bare instruction string, so Mock and Seeduplex no longer match on instruction text. Each session receives a `SessionContext` (owner, agent, role, style, voice), resolved at `POST /session` by a `ContextResolver` and turned into persona and Director config by a `RoleCatalog`. Task 0 ships stubs for both (`devContextResolver`, `fixedRoleCatalog`); Plan B replaces the resolver and Plan A replaces the catalog, with no further edits to `gateway/src/index.ts` logic.

**Tech Stack:** Node 24, TypeScript, Vitest, zod (already present). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-companionship-memory-design.md`, sections "契约变更" and "计划拆分与执行 → Task 0".

## Global Constraints

- Behavior must not change: all existing gateway tests pass after each task (update only call sites named in this plan). Mock speaks the same scripted lines; Seeduplex speaks the same Director texts; Qwen sends the same events.
- Never log conversation content (audio, ASR text, reply text). Logs carry event names, ids, counts, durations, error codes only.
- No new dependencies. No changes to `protocol/` WS messages, binary frames, or Bridge messages.
- Code comments in English, short.
- Run commands from the repo root unless a step says otherwise. Gateway tests: `npm test -w gateway`; typecheck: `npm run typecheck -w gateway`.
- Stage explicit paths only; never `git add -A`.
- Commit message trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `gateway/src/adapters/types.ts` | modify | `ProactiveCue`, `ProactiveRequest`, `createResponse(request?)`, `SessionConfig.voice?` |
| `gateway/src/session/director.ts` | modify | Emits `ProactiveRequest` per cue |
| `gateway/src/adapters/mock.ts` | modify | Scripted line chosen by cue; drop `instructionReplies` |
| `gateway/src/adapters/seeduplex.ts` | modify | Speaks `fallbackText`; drop `proactiveTexts`; per-session voice |
| `gateway/src/adapters/qwen.ts` | modify | Speaks from `instruction`; per-session voice |
| `gateway/src/roles/catalog.ts` | create | `RoleCatalog` interface + `fixedRoleCatalog` stub |
| `gateway/src/session/context.ts` | create | `SessionContext`, `ContextResolver`, `devContext`, `devContextResolver` |
| `gateway/src/session/session.ts` | modify | `new Session(deps, ctx)`; persona/director/voice from ctx + catalog |
| `gateway/src/session/manager.ts` | modify | `makeSession(ctx)`, `create(ctx)` |
| `gateway/src/server/server.ts` | modify | Parse optional Bearer on `/session`, resolve context, 401 on failure, CORS allows `authorization` |
| `gateway/src/index.ts` | modify | Wire catalog + resolver; remove instruction-text maps |
| tests | modify/create | `director`, `mock`, `seeduplex`, `seeduplex.integration`, `qwen`, `session`, `server`, new `catalog`/`context` |

---

### Task 1: Structured Director requests (`ProactiveRequest`)

**Files:**
- Modify: `gateway/src/adapters/types.ts`
- Modify: `gateway/src/session/director.ts`
- Modify: `gateway/src/session/session.ts:75` and `:213-217`
- Modify: `gateway/src/adapters/mock.ts:26-30,106-111`
- Modify: `gateway/src/adapters/seeduplex.ts:13,32,38,90-93`
- Modify: `gateway/src/adapters/qwen.ts:62-66`
- Modify: `gateway/src/index.ts:20-32,40-44`
- Test: `gateway/test/director.test.ts`, `gateway/test/mock.test.ts`, `gateway/test/seeduplex.test.ts`, `gateway/test/seeduplex.integration.test.ts`, `gateway/test/qwen.test.ts`

**Interfaces:**
- Produces (in `gateway/src/adapters/types.ts`):
  ```ts
  export type ProactiveCue = 'greeting' | 'followup' | 'idleNotice' | 'resume';
  export interface ProactiveRequest { cue: ProactiveCue; instruction: string; fallbackText: string }
  // RealtimeAdapter
  createResponse(request?: ProactiveRequest): void;
  ```
- Produces (in `gateway/src/session/director.ts`): `DirectorDeps.requestResponse(kind: ResponseKind, request: ProactiveRequest): void`.
- Later plans add cues (for example `'topic'`, `'notice'`, `'forgetAck'`) by extending the `ProactiveCue` union; that is an additive change.

- [x] **Step 1: Write the failing Director test**

In `gateway/test/director.test.ts`, change the import line and `make()` helper, then add a test inside `describe('Director', ...)`:

```ts
import type { ProactiveRequest } from '../src/adapters/types.ts';
```

```ts
function make(c: DirectorConfig = cfg) {
  const calls: Array<[ResponseKind, string]> = [];
  const d = new Director(c, { requestResponse: (k, r) => calls.push([k, r.instruction]) });
  return { d, calls };
}
```

```ts
  it('passes cue and fallback text with each request', () => {
    const reqs: ProactiveRequest[] = [];
    const d = new Director(cfg, { requestResponse: (_k, r) => reqs.push(r) });
    d.onSessionStart();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(8000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(25000);
    d.resume();
    expect(reqs).toEqual([
      { cue: 'greeting', instruction: 'G', fallbackText: 'greeting' },
      { cue: 'followup', instruction: 'F', fallbackText: 'followup' },
      { cue: 'idleNotice', instruction: 'I', fallbackText: 'idle' },
    ]);
  });
```

(`resume()` is rate limited by `maxPerWindow: 3` after three requests, so it adds nothing; that keeps the expectation exact.)

- [x] **Step 2: Run it to verify it fails**

Run: `npm test -w gateway -- test/director.test.ts`
Expected: FAIL (TypeScript/runtime: `r.instruction` is undefined because `requestResponse` still receives a string).

- [x] **Step 3: Add the types**

In `gateway/src/adapters/types.ts`, add above `export type AdapterEvents`:

```ts
/** What the Director wants said. Qwen speaks from `instruction`; adapters that cannot prompt the model speak `fallbackText`. */
export type ProactiveCue = 'greeting' | 'followup' | 'idleNotice' | 'resume';

export interface ProactiveRequest {
  cue: ProactiveCue;
  instruction: string;
  fallbackText: string;
}
```

and change the `RealtimeAdapter` member:

```ts
  createResponse(request?: ProactiveRequest): void;
```

- [x] **Step 4: Update the Director**

In `gateway/src/session/director.ts`:

```ts
import type { ResponseKind } from '@anyidea/protocol';
import type { ProactiveCue, ProactiveRequest } from '../adapters/types.ts';
```

```ts
export interface DirectorDeps {
  requestResponse(kind: ResponseKind, request: ProactiveRequest): void;
}
```

Replace `onSessionStart`, `resume`, `arm`, and `fire` with:

```ts
  onSessionStart(): void {
    this.deps.requestResponse('greeting', this.request('greeting'));
  }
```

```ts
  resume(): void {
    this.paused = false;
    this.consecutive = 0;
    if (!this.blocked() && this.takeSpeechSlot()) this.deps.requestResponse('followup', this.request('resume'));
  }
```

```ts
  /** Starts the silence timer: first a follow-up, then (if still silent) the idle notice. */
  private arm(): void {
    this.clear();
    if (this.blocked() || this.consecutive >= this.cfg.maxConsecutive) return;
    const isLast = this.consecutive === this.cfg.maxConsecutive - 1;
    const delay = this.consecutive === 0 ? this.cfg.followupAfterMs : this.cfg.idleNoticeAfterMs;
    const cue: ProactiveCue = isLast ? 'idleNotice' : 'followup';
    this.timer = setTimeout(() => this.fire(cue), delay);
  }
```

```ts
  private fire(cue: ProactiveCue): void {
    this.timer = null;
    if (this.blocked()) return;
    if (!this.takeSpeechSlot()) return;
    this.consecutive++;
    this.deps.requestResponse('followup', this.request(cue));
  }

  private request(cue: ProactiveCue): ProactiveRequest {
    const c = this.cfg;
    switch (cue) {
      case 'greeting': return { cue, instruction: c.greetingInstruction, fallbackText: c.greetingText };
      case 'followup': return { cue, instruction: c.followupInstruction, fallbackText: c.followupText };
      case 'idleNotice': return { cue, instruction: c.idleNoticeInstruction, fallbackText: c.idleNoticeText };
      case 'resume': return { cue, instruction: c.resumeInstruction, fallbackText: c.resumeText };
    }
  }
```

- [x] **Step 5: Update Session to forward the request**

In `gateway/src/session/session.ts`, add `type ProactiveRequest` to the existing `../adapters/types.ts` import, then:

```ts
    this.director = new Director(deps.director, { requestResponse: (kind, request) => this.requestResponse(kind, request) });
```

```ts
  private requestResponse(kind: ResponseKind, request: ProactiveRequest): void {
    if (this.ended || this.interrupt.active !== null) return; // never talk over an active response
    this.pendingKind = kind;
    this.adapter.createResponse(request);
  }
```

- [x] **Step 6: Run the Director tests**

Run: `npm test -w gateway -- test/director.test.ts`
Expected: PASS (all existing Director tests plus the new one).

- [x] **Step 7: Write failing adapter tests**

In `gateway/test/mock.test.ts`, replace the two tests `'answers the first createResponse with the greeting, later ones with the follow-up'` and `'uses the scripted line mapped to a known Director instruction'` with:

```ts
  it('answers bare createResponse calls with the greeting first, then the follow-up', async () => {
    const m = make();
    const c = collect(m);
    m.createResponse();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好');
    m.createResponse();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好还在吗');
  });

  it('speaks the scripted line for each Director cue', async () => {
    const m = new MockAdapter({ script: { ...script, idleNotice: '我在呢' }, replyDelayMs: 100, charMs: 200, chunkMs: 100, paceFactor: 1 });
    const c = collect(m);
    m.createResponse({ cue: 'idleNotice', instruction: 'IDLE', fallbackText: 'unused' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢');
    m.createResponse({ cue: 'resume', instruction: 'R', fallbackText: 'unused' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢还在吗'); // no scripted resume line: falls back to the follow-up
  });
```

In `gateway/test/seeduplex.test.ts:28,36`, construct the adapter without `proactiveTexts` and call:

```ts
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture-voice' });
```

```ts
    await adapter.connect(config); await wait(); adapter.createResponse({ cue: 'greeting', instruction: 'G', fallbackText: 'safe greeting' }); await wait();
```

In `gateway/test/seeduplex.integration.test.ts:56-59`, drop the `proactiveTexts` line:

```ts
      adapterFactory: () => new SeeduplexAdapter({
        apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${upstreamPort}`, voice: 'fixture',
      }),
```

In `gateway/test/qwen.test.ts:126`:

```ts
    a.createResponse({ cue: 'greeting', instruction: 'fixture instruction', fallbackText: 'unused' });
```

- [x] **Step 8: Run them to verify they fail**

Run: `npm test -w gateway -- test/mock.test.ts test/seeduplex.test.ts test/seeduplex.integration.test.ts test/qwen.test.ts`
Expected: FAIL. Mock ignores the cue (`我在呢` missing), Seeduplex sends no commit (the event list misses `start:r1`), and the integration test gets no greeting audio.

- [x] **Step 9: Update the adapters**

`gateway/src/adapters/mock.ts`: delete the `instructionReplies` option and its doc comment from `MockOptions` (lines 28-29), import the types, and replace `createResponse`:

```ts
import type { ProactiveCue, ProactiveRequest } from './types.ts';
```

```ts
  createResponse(request?: ProactiveRequest): void {
    const s = this.opts.script;
    const byCue: Record<ProactiveCue, string> = {
      greeting: s.greeting,
      followup: s.followup,
      idleNotice: s.idleNotice ?? s.followup,
      resume: s.resume ?? s.followup,
    };
    const text = request ? byCue[request.cue] : this.createCount === 0 ? s.greeting : s.followup;
    this.createCount++;
    this.scheduleReply(text);
  }
```

(If `mock.ts` already imports from `./types.ts`, merge the names into that import.)

`gateway/src/adapters/seeduplex.ts`: delete the `proactiveTexts?` option (line 13), the `proactiveTexts` field (line 32), and its assignment (line 38). Add `ProactiveRequest` to the `./types.ts` import and replace `createResponse`:

```ts
  createResponse(request?: ProactiveRequest): void {
    if (this.connected && request?.fallbackText) this.send({ type: 'speech_text_buffer.commit', event_id: this.eventId(), text: request.fallbackText });
  }
```

`gateway/src/adapters/qwen.ts`: add `ProactiveRequest` to the `./types.ts` import and replace `createResponse`:

```ts
  createResponse(request?: ProactiveRequest): void {
    if (!this.connected) return;
    if (request) this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: request.instruction }] } });
    this.send({ type: 'response.create' });
  }
```

`gateway/src/index.ts`: delete the `instructionReplies` and `proactiveTexts` maps (lines 20-32) and remove those two properties from the adapter constructors:

```ts
      adapterFactory: () => config.adapter === 'seeduplex'
        ? new SeeduplexAdapter({ apiKey: config.seeduplexApiKey!, endpoint: config.seeduplexEndpoint, model: config.seeduplexModel, voice: config.seeduplexVoice })
        : config.adapter === 'qwen'
          ? new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice })
          : new MockAdapter({ script, speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor }),
```

- [x] **Step 10: Run the full gateway suite and typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: all tests PASS (one more than before this task: the new Director test; the two Mock tests are replaced one-for-one), typecheck clean. Record the actual count in the commit body.

- [x] **Step 11: Commit**

```bash
git add gateway/src/adapters/types.ts gateway/src/session/director.ts gateway/src/session/session.ts gateway/src/adapters/mock.ts gateway/src/adapters/seeduplex.ts gateway/src/adapters/qwen.ts gateway/src/index.ts gateway/test/director.test.ts gateway/test/mock.test.ts gateway/test/seeduplex.test.ts gateway/test/seeduplex.integration.test.ts gateway/test/qwen.test.ts
git commit -m "refactor(gateway): send structured Director requests to adapters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Per-session voice (`SessionConfig.voice`)

**Files:**
- Modify: `gateway/src/adapters/types.ts:10-13`
- Modify: `gateway/src/adapters/qwen.ts:43`
- Modify: `gateway/src/adapters/seeduplex.ts:29-30,43-44` and `sessionPayload()`
- Test: `gateway/test/qwen.test.ts`, `gateway/test/seeduplex.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SessionConfig { instructions: string; tools: ToolSpec[]; voice?: string }`. `undefined` means "use the adapter's configured default voice" (`QWEN_VOICE` / `SEEDUPLEX_VOICE`).

- [x] **Step 1: Write the failing tests**

Append to `describe('QwenAdapter', ...)` in `gateway/test/qwen.test.ts`:

```ts
  it('uses the per-session voice when the session config provides one', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const voices: unknown[] = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as { type: string; session?: { audio?: { output?: { voice?: unknown } } } };
      if (e.type === 'session.update') {
        voices.push(e.session?.audio?.output?.voice);
        ws.send(JSON.stringify({ type: 'session.created' }));
        ws.send(JSON.stringify({ type: 'session.updated' }));
      }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'default-voice' });
    await a.connect({ instructions: 'fixture', tools: [], voice: 'session-voice' });
    a.close();
    const b = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'default-voice' });
    await b.connect({ instructions: 'fixture', tools: [] });
    b.close();
    expect(voices).toEqual(['session-voice', 'default-voice']);
  });
```

Append to `describe('SeeduplexAdapter', ...)` in `gateway/test/seeduplex.test.ts`:

```ts
  it('uses the per-session voice when the session config provides one', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const voices: unknown[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string; session?: { audio?: { output?: { voice?: unknown } } } };
      if (event.type === 'session.create') {
        voices.push(event.session?.audio?.output?.voice);
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
      }
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'default-voice' });
    await adapter.connect({ ...config, voice: 'session-voice' }); await wait();
    adapter.close();
    expect(voices).toEqual(['session-voice']);
  });
```

- [x] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/qwen.test.ts test/seeduplex.test.ts`
Expected: FAIL. TypeScript rejects `voice` on `SessionConfig`; after that, the voices are `['default-voice', ...]`.

- [x] **Step 3: Implement**

`gateway/src/adapters/types.ts`:

```ts
export interface SessionConfig {
  instructions: string;
  tools: ToolSpec[];
  /** Per-session voice; undefined = the adapter's configured default. */
  voice?: string;
}
```

`gateway/src/adapters/qwen.ts:43`: in the `session.update` payload, replace `voice: this.opts.voice` with:

```ts
voice: config.voice ?? this.opts.voice
```

`gateway/src/adapters/seeduplex.ts`: add a field next to `instructions`/`tools`:

```ts
  private voice = '';
```

in `connect(config)` next to `this.tools = config.tools;`:

```ts
    this.voice = config.voice ?? this.opts.voice;
```

and in `sessionPayload()` replace `voice: this.opts.voice` with `voice: this.voice`.

- [x] **Step 4: Run tests and typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add gateway/src/adapters/types.ts gateway/src/adapters/qwen.ts gateway/src/adapters/seeduplex.ts gateway/test/qwen.test.ts gateway/test/seeduplex.test.ts
git commit -m "feat(gateway): let each session choose its adapter voice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `RoleCatalog`, `SessionContext`, and `new Session(deps, ctx)`

**Files:**
- Create: `gateway/src/roles/catalog.ts`
- Create: `gateway/src/session/context.ts`
- Modify: `gateway/src/session/session.ts:20-33,72-81,205-211`
- Modify: `gateway/src/index.ts:15-16,34-56`
- Test: create `gateway/test/catalog.test.ts`; modify `gateway/test/session.test.ts`, `gateway/test/server.test.ts:28-38`, `gateway/test/seeduplex.integration.test.ts:55-61`

**Interfaces:**
- Produces (`gateway/src/roles/catalog.ts`):
  ```ts
  export interface RoleCatalog {
    defaultRole(): string;
    defaultStyle(roleId: string): string;
    hasStyle(roleId: string, styleId: string): boolean;
    voiceFor(roleId: string, styleId: string): string | undefined;
    buildPersona(roleId: string, styleId: string): string;
    director(roleId: string): DirectorConfig;
  }
  export const DEFAULT_ROLE = 'elder-companion';
  export function fixedRoleCatalog(persona: string, director: DirectorConfig): RoleCatalog;
  ```
  Plan A replaces the stub with a file-backed catalog that implements the same interface. Plan B uses `hasStyle`/`defaultStyle`/`voiceFor`.
- Produces (`gateway/src/session/context.ts`):
  ```ts
  export interface SessionContext { ownerId?: string; agentId?: string; roleId: string; styleId: string; voice?: string; memorySnapshot?: string }
  export function devContext(roles: RoleCatalog): SessionContext;
  ```
- Produces (`gateway/src/session/session.ts`): `SessionDeps` loses `persona` and `director`, gains `roles: RoleCatalog`; constructor is `new Session(deps: SessionDeps, ctx: SessionContext = devContext(deps.roles))`; `readonly context: SessionContext`. `sessionConfig()` passes `voice: ctx.voice`. `memorySnapshot` is stored but unused until Plan C.

- [x] **Step 1: Write the failing catalog test**

Create `gateway/test/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE, fixedRoleCatalog } from '../src/roles/catalog.ts';
import { devContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';

const director = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
} satisfies DirectorConfig;

describe('fixedRoleCatalog', () => {
  it('exposes the default role with both stub styles sharing one persona', () => {
    const roles = fixedRoleCatalog('P', director);
    expect(roles.defaultRole()).toBe(DEFAULT_ROLE);
    expect(roles.defaultStyle(DEFAULT_ROLE)).toBe('grandchild');
    expect(roles.hasStyle(DEFAULT_ROLE, 'grandchild')).toBe(true);
    expect(roles.hasStyle(DEFAULT_ROLE, 'old-friend')).toBe(true);
    expect(roles.hasStyle(DEFAULT_ROLE, 'pirate')).toBe(false);
    expect(roles.hasStyle('other-role', 'grandchild')).toBe(false);
    expect(roles.buildPersona(DEFAULT_ROLE, 'old-friend')).toBe('P');
    expect(roles.voiceFor(DEFAULT_ROLE, 'grandchild')).toBeUndefined();
    expect(roles.director(DEFAULT_ROLE)).toBe(director);
  });

  it('builds a dev context from the catalog defaults', () => {
    expect(devContext(fixedRoleCatalog('P', director))).toEqual({ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined });
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npm test -w gateway -- test/catalog.test.ts`
Expected: FAIL with "Failed to load url ../src/roles/catalog.ts" (module not found).

- [x] **Step 3: Create the catalog and context modules**

`gateway/src/roles/catalog.ts`:

```ts
import type { DirectorConfig } from '../session/director.ts';

/** Role and style lookup. Task 0 ships a stub; Plan A replaces it with files under gateway/roles/. */
export interface RoleCatalog {
  defaultRole(): string;
  defaultStyle(roleId: string): string;
  hasStyle(roleId: string, styleId: string): boolean;
  /** undefined = the adapter's configured default voice. */
  voiceFor(roleId: string, styleId: string): string | undefined;
  buildPersona(roleId: string, styleId: string): string;
  director(roleId: string): DirectorConfig;
}

export const DEFAULT_ROLE = 'elder-companion';
const STUB_STYLES: readonly string[] = ['grandchild', 'old-friend'];

/** Stub: every style of the default role shares one persona and Director config. */
export function fixedRoleCatalog(persona: string, director: DirectorConfig): RoleCatalog {
  return {
    defaultRole: () => DEFAULT_ROLE,
    defaultStyle: () => 'grandchild',
    hasStyle: (roleId, styleId) => roleId === DEFAULT_ROLE && STUB_STYLES.includes(styleId),
    voiceFor: () => undefined,
    buildPersona: () => persona,
    director: () => director,
  };
}
```

`gateway/src/session/context.ts`:

```ts
import type { RoleCatalog } from '../roles/catalog.ts';

/** Per-session identity and role choice. Resolved on the server; never taken from client input. */
export interface SessionContext {
  ownerId?: string;
  agentId?: string;
  roleId: string;
  styleId: string;
  /** undefined = the adapter's configured default voice. */
  voice?: string;
  /** Frozen memory snapshot injected at session start (Plan C). */
  memorySnapshot?: string;
}

/** Context for sessions without a device token (dev / Mock mode): no owner, no memory. */
export function devContext(roles: RoleCatalog): SessionContext {
  const roleId = roles.defaultRole();
  const styleId = roles.defaultStyle(roleId);
  return { roleId, styleId, voice: roles.voiceFor(roleId, styleId) };
}
```

- [x] **Step 4: Run the catalog test**

Run: `npm test -w gateway -- test/catalog.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing Session test and migrate Session test setup**

In `gateway/test/session.test.ts`:
- add imports:
  ```ts
  import type { SessionConfig } from '../src/adapters/types.ts';
  import { fixedRoleCatalog, type RoleCatalog } from '../src/roles/catalog.ts';
  ```
- in `setup()`, replace `persona: 'P',` and `director,` with:
  ```ts
    roles: fixedRoleCatalog('P', director),
  ```
- add this test inside `describe('Session', ...)`:

```ts
  it('builds instructions and voice from the session context', async () => {
    const configs: SessionConfig[] = [];
    const roles: RoleCatalog = { ...fixedRoleCatalog('P', director), buildPersona: (_r, s) => `persona:${s}` };
    const session = new Session(
      {
        adapterFactory: () => {
          const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
          const connect = m.connect.bind(m);
          vi.spyOn(m, 'connect').mockImplementation((c) => { configs.push(c); return connect(c); });
          return m;
        },
        summarizer: new MockSummarizer(),
        roles,
      },
      { roleId: 'elder-companion', styleId: 'old-friend', voice: 'voice-old' },
    );
    await session.start(collector().transport);
    expect(configs[0]?.voice).toBe('voice-old');
    expect(configs[0]?.instructions).toContain('persona:old-friend');
    expect(session.context.styleId).toBe('old-friend');
    session.end();
  });
```

In `gateway/test/server.test.ts:28-38` and `gateway/test/seeduplex.integration.test.ts:55-61`, replace `persona: 'P', director,` / `persona: 'persona', director,` with `roles: fixedRoleCatalog('P', director),` and add `import { fixedRoleCatalog } from '../src/roles/catalog.ts';` to each file.

- [x] **Step 6: Run to verify failure**

Run: `npm test -w gateway -- test/session.test.ts`
Expected: FAIL. TypeScript reports that `roles` does not exist in `SessionDeps`, and the two-argument constructor and `session.context` do not exist.

- [x] **Step 7: Implement in Session**

In `gateway/src/session/session.ts`:
- imports:
  ```ts
  import type { RoleCatalog } from '../roles/catalog.ts';
  import { devContext, type SessionContext } from './context.ts';
  ```
- in `SessionDeps`, delete `persona: string;` and `director: DirectorConfig;`, add:
  ```ts
  roles: RoleCatalog;
  ```
  (remove `type DirectorConfig` from the `./director.ts` import if it becomes unused)
- fields and constructor:
  ```ts
  readonly context: SessionContext;
  private readonly persona: string;
  ```
  ```ts
  constructor(private readonly deps: SessionDeps, ctx: SessionContext = devContext(deps.roles)) {
    this.context = ctx;
    this.persona = deps.roles.buildPersona(ctx.roleId, ctx.styleId);
    this.ledger = new ConversationLedger(deps.ledger ?? DEFAULT_LEDGER_OPTIONS);
    this.director = new Director(deps.roles.director(ctx.roleId), { requestResponse: (kind, request) => this.requestResponse(kind, request) });
    // ...rest of the existing constructor body unchanged (interrupt, adapter)
  }
  ```
- instructions and config:
  ```ts
  private instructions(): string {
    return this.ledger.buildInstructions(this.persona);
  }

  private sessionConfig(): SessionConfig {
    return { instructions: this.instructions(), tools: [PERFORM_ACTION_TOOL], voice: this.context.voice };
  }
  ```

- [x] **Step 8: Wire the stub catalog in `index.ts`**

In `gateway/src/index.ts`:
- replace lines 15-16 (`const director = ...; const persona = ...;`) with:
  ```ts
  // Stub until Plan A ships file-backed roles under gateway/roles/.
  const roles = fixedRoleCatalog(loadPersona(`${root}prompts/persona.md`), loadDirectorConfig(`${root}config/director.json`));
  ```
- add `import { fixedRoleCatalog } from './roles/catalog.ts';`
- in the `new Session({...})` deps, replace `persona,` and `director,` with `roles,`.

(Task 4 changes the factory to take a context; leave `() => new Session({...})` as is for now.)

- [x] **Step 9: Run tests and typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS, typecheck clean.

- [x] **Step 10: Commit**

```bash
git add gateway/src/roles/catalog.ts gateway/src/session/context.ts gateway/src/session/session.ts gateway/src/index.ts gateway/test/catalog.test.ts gateway/test/session.test.ts gateway/test/server.test.ts gateway/test/seeduplex.integration.test.ts
git commit -m "feat(gateway): build sessions from a role catalog and session context

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `ContextResolver`, `manager.create(ctx)`, and Bearer parsing on `/session`

**Files:**
- Modify: `gateway/src/session/context.ts`
- Modify: `gateway/src/session/manager.ts:24,35-41`
- Modify: `gateway/src/server/server.ts:10-22,62-69,89-100`
- Modify: `gateway/src/index.ts`
- Test: `gateway/test/catalog.test.ts`, `gateway/test/server.test.ts`, `gateway/test/seeduplex.integration.test.ts`

**Interfaces:**
- Consumes: `SessionContext`, `devContext`, `RoleCatalog` (Task 3).
- Produces (`gateway/src/session/context.ts`):
  ```ts
  export type ResolveResult = { ok: true; ctx: SessionContext } | { ok: false };
  export interface ContextResolver { resolve(bearer: string | undefined): ResolveResult }
  export function devContextResolver(roles: RoleCatalog): ContextResolver;
  ```
  Plan B implements a MemoryStore-backed `ContextResolver` and swaps it in `index.ts` (one-line change at the marked wiring point).
- Produces (`gateway/src/session/manager.ts`): `new SessionManager(makeSession: (ctx: SessionContext) => Session, ...)`, `create(ctx: SessionContext): SessionTokens`.
- Produces (`gateway/src/server/server.ts`): `GatewayServerOptions.contextResolver: ContextResolver` (required). `/session` still requires `x-app-secret`; an `Authorization` header, if present, must be `Bearer <16-128 chars of [A-Za-z0-9_-]>` and resolve successfully, else 401 `{ error: 'unauthorized' }`.

- [x] **Step 1: Write the failing tests**

Append to `gateway/test/catalog.test.ts`:

```ts
import { devContextResolver } from '../src/session/context.ts';

describe('devContextResolver', () => {
  it('accepts requests without a bearer and rejects any bearer until identity exists', () => {
    const resolver = devContextResolver(fixedRoleCatalog('P', director));
    expect(resolver.resolve(undefined)).toEqual({ ok: true, ctx: { roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined } });
    expect(resolver.resolve('device-token-0123456789')).toEqual({ ok: false });
  });
});
```

In `gateway/test/server.test.ts`:
- imports:
  ```ts
  import { devContextResolver, type ContextResolver, type SessionContext } from '../src/session/context.ts';
  ```
- extend the `boot` options type with `contextResolver?: ContextResolver; onContext?: (ctx: SessionContext) => void`, change the factory and server options:
  ```ts
  const roles = fixedRoleCatalog('P', director);
  manager = new SessionManager(
    (ctx) => {
      opts.onContext?.(ctx);
      return new Session({
        adapterFactory: () => {
          const adapter = new MockAdapter({ script, replyDelayMs: 10, charMs: 20, chunkMs: 20, paceFactor: 1 });
          if (opts.adapterConnect === 'fail') vi.spyOn(adapter, 'connect').mockRejectedValue(new Error('connect failed'));
          if (opts.adapterConnect === 'hang') vi.spyOn(adapter, 'connect').mockImplementation(() => new Promise<void>(() => {}));
          return adapter;
        },
        summarizer: new MockSummarizer(),
        roles,
      }, ctx);
    },
    opts.graceMs ?? 60_000,
    opts.unclaimedMs,
    opts.startTimeoutMs,
  );
  server = createGatewayServer({
    manager,
    appSecret: SECRET,
    contextResolver: opts.contextResolver ?? devContextResolver(roles),
    // ...existing options unchanged
  });
  ```
- add tests:

```ts
  it('rejects malformed or unknown bearer tokens on /session', async () => {
    const base = await boot();
    for (const authorization of ['Bearer short', 'Basic abcdefghijklmnopqrstu', 'Bearer abcdefghijklmnopqrstuvwxyz012345']) {
      const res = await fetch(base + '/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-secret': SECRET, authorization }, body: '{}' });
      expect(res.status).toBe(401);
    }
  });

  it('hands the resolved context to the session factory', async () => {
    const seen: SessionContext[] = [];
    const ctx: SessionContext = { ownerId: 'o1', agentId: 'a1', roleId: 'elder-companion', styleId: 'old-friend', voice: 'voice-old' };
    const base = await boot({
      contextResolver: { resolve: (b) => (b === 'device-token-0123456789' ? { ok: true, ctx } : { ok: false }) },
      onContext: (c) => seen.push(c),
    });
    const res = await fetch(base + '/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-secret': SECRET, authorization: 'Bearer device-token-0123456789' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([ctx]);
  });

  it('allows the authorization header in CORS preflight for loopback origins', async () => {
    const base = await boot();
    const res = await fetch(base + '/session', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5173' } });
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });
```

(Check the existing `'answers CORS preflight only for loopback origins'` test at `server.test.ts:126` for the exact loopback origin string it uses, and use the same one here.)

In `gateway/test/seeduplex.integration.test.ts`, change the factory to `(ctx) => new Session({...}, ctx)` and pass `contextResolver: devContextResolver(roles)` to `createGatewayServer`, with `const roles = fixedRoleCatalog('P', director);` declared before both, and import `devContextResolver`.

- [x] **Step 2: Run them to verify they fail**

Run: `npm test -w gateway -- test/catalog.test.ts test/server.test.ts test/seeduplex.integration.test.ts`
Expected: FAIL. `devContextResolver` is not exported, `contextResolver` is not a known option, and the bearer requests return 200.

- [x] **Step 3: Implement the resolver**

Append to `gateway/src/session/context.ts`:

```ts
export type ResolveResult = { ok: true; ctx: SessionContext } | { ok: false };

/** Maps the optional device bearer token to a session context. Plan B replaces the stub with a MemoryStore-backed resolver. */
export interface ContextResolver {
  resolve(bearer: string | undefined): ResolveResult;
}

/** Stub: dev / Mock sessions only. Any bearer is unknown until device identity exists. */
export function devContextResolver(roles: RoleCatalog): ContextResolver {
  return { resolve: (bearer) => (bearer === undefined ? { ok: true, ctx: devContext(roles) } : { ok: false }) };
}
```

- [x] **Step 4: Implement the manager change**

In `gateway/src/session/manager.ts`:

```ts
import type { SessionContext } from './context.ts';
```

```ts
    private readonly makeSession: (ctx: SessionContext) => Session,
```

```ts
  create(ctx: SessionContext): SessionTokens {
    const sessionId = randomUUID();
    // claim() clears this timer, like the disconnect grace timer.
    const grace = setTimeout(() => this.destroy(sessionId, 'unclaimed'), this.unclaimedMs);
    this.sessions.set(sessionId, { session: this.makeSession(ctx), started: false, starting: false, connId: 0, terminate: null, grace });
    log('session_created', { sessions: this.sessions.size });
    return this.tokens.issue(sessionId);
  }
```

- [x] **Step 5: Implement the server change**

In `gateway/src/server/server.ts`:
- `import type { ContextResolver } from '../session/context.ts';`
- add to `GatewayServerOptions`:
  ```ts
  /** Resolves the optional device bearer on POST /session into a session context. */
  contextResolver: ContextResolver;
  ```
- CORS headers (line 67):
  ```ts
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-app-secret, authorization');
  ```
- add a helper at module level:
  ```ts
  const BEARER = /^Bearer ([A-Za-z0-9_-]{16,128})$/;

  /** undefined = no Authorization header; null = present but malformed. */
  function bearerToken(req: IncomingMessage): string | undefined | null {
    const header = req.headers.authorization;
    if (header === undefined) return undefined;
    return BEARER.exec(header)?.[1] ?? null;
  }
  ```
- in the `/session` branch, replace `json(res, 200, opts.manager.create());` with:
  ```ts
    const bearer = bearerToken(req);
    const resolved = bearer === null ? null : opts.contextResolver.resolve(bearer);
    if (!resolved?.ok) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    json(res, 200, opts.manager.create(resolved.ctx));
  ```

- [x] **Step 6: Wire `index.ts`**

In `gateway/src/index.ts`:
- `import { devContextResolver } from './session/context.ts';`
- factory: change `() => new Session({ ... })` to `(ctx) => new Session({ ... }, ctx)`.
- server options: add
  ```ts
  // Wiring point: Plan B swaps in the MemoryStore-backed resolver here.
  contextResolver: devContextResolver(roles),
  ```

- [x] **Step 7: Run tests and typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS, typecheck clean.

- [x] **Step 8: Commit**

```bash
git add gateway/src/session/context.ts gateway/src/session/manager.ts gateway/src/server/server.ts gateway/src/index.ts gateway/test/catalog.test.ts gateway/test/server.test.ts gateway/test/seeduplex.integration.test.ts
git commit -m "feat(gateway): resolve session context from an optional device bearer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full verification and roadmap update

**Files:**
- Modify: `docs/project/roadmap.md`
- Modify: this plan file (tick boxes)

- [x] **Step 1: Run every JS suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: protocol, gateway, avatar-core all PASS; typecheck clean. Record the exact counts.

- [x] **Step 2: Live smoke on Mock**

Run (from repo root, in a separate terminal; `APP_SECRET` must be ≥16 chars):

```bash
ADAPTER=mock APP_SECRET=local-dev-secret-0123 PORT=8797 npm start -w gateway
```

then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-app-secret: local-dev-secret-0123' -H 'content-type: application/json' -d '{}' http://127.0.0.1:8797/session
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-app-secret: local-dev-secret-0123' -H 'authorization: Bearer device-token-0123456789' -H 'content-type: application/json' -d '{}' http://127.0.0.1:8797/session
```

Expected: `200` then `401`. Stop the gateway afterwards. (Port 8797 keeps the user's Qwen gateway on 8787 untouched.) (If `.env` already sets these variables, the inline values override them.)

Verified on 2026-10-18 with `node --import tsx docs/testing/plan3-mock-smoke.mjs`: identity off, `/session` 200 without bearer and 401 with forged bearer; gateway stopped cleanly. See `docs/blockers.md` #11.

- [x] **Step 3: Document worktree preparation**

Plan A (A1 then A2, one worktree, serial) and Plan B (second worktree) run in parallel. Ignored files do not follow a worktree, so add this block to `docs/project/roadmap.md` under "Repo notes":

```text
Plan 3 worktree prep (run inside each new worktree):
  npm ci
  cp ../avatar/gateway/.env gateway/.env        # if present; never commit
  cp ../avatar/app/dev.json app/dev.json        # never commit
  ./scripts/fetch-assets.sh                     # avatar GLB/animations, if the worktree needs the app
  ./scripts/build-web.sh                        # before any flutter build
  (cd app && flutter pub get)
Worktrees: plan3-a (A1 → A2 serial), plan3-b. Device gates run one at a time on the Xiaomi;
ask the user before restarting the 8787 gateway; smoke runs use 8797.
```

(Check that `scripts/fetch-assets.sh` exists with `ls scripts/`; if it does not, drop that line.)

- [x] **Step 4: Update the roadmap**

In `docs/project/roadmap.md`, change the Plan 3 row status to say Task 0 is complete with the test counts from Step 1, and replace Next steps item 0 with: "Plan 3: Task 0 complete; Plan A and Plan B may start in parallel worktrees (file ownership per spec)."

- [x] **Step 5: Commit**

```bash
git add docs/project/roadmap.md docs/superpowers/plans/2026-10-17-plan3-task0-contracts.md
git commit -m "docs: record Plan 3 Task 0 completion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Acceptance (from the spec)

- All existing tests pass; Mock and Seeduplex behavior is unchanged with `fallbackText` (Task 1 tests).
- `SessionContext`, `RoleCatalog`, `ContextResolver`, `manager.create(ctx)`, `SessionConfig.voice?` exist with stubs and are wired in `index.ts`; after Task 0, Plan A replaces `fixedRoleCatalog` and Plan B replaces `devContextResolver` at the marked wiring points without other `index.ts` logic changes.
