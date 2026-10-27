# P2-T6: `admin/` 工程、设计 token、布局、登录与 API 客户端

**目标：** 新建 npm workspace `admin/`（Vite + TS + React + Ant Design），落地 spec「界面设计」的色彩、字体、布局骨架；做好登录页、带 CSRF 的 API 客户端、401 自动回到登录页、哈希路由和侧栏。产物 `admin/dist` 由网关后台端口托管（C7 `staticDir`），镜像构建时一起打包。

**实现的 spec 章节：** 「界面设计」的色彩、字体、布局、文案规则；「架构 / 分层与进程」中的静态文件托管；决策 Q7、Q36、Q38。

**前置：** 计划 1 全部完成；P2-T1 已合入（`protocol/src/adminApi.ts` 导出 C6 类型，并经 `protocol/src/index.ts` re-export）。本任务可以和 P2-T2–T5 并行（不碰网关源码）。开始前在仓库根目录跑：

```bash
npm test -w protocol && npm run typecheck -w protocol
grep -n "AdminOverview" protocol/src/index.ts protocol/src/adminApi.ts
```

预期：测试通过；两个文件都能 grep 到 `AdminOverview`（index 里是 re-export）。grep 不到说明 P2-T1 没合入，停下。

**Files:**
- Modify: `package.json`（根，workspaces 加 `"admin"`）
- Modify: `Dockerfile.gateway`（新增 admin 构建阶段，把 `admin/dist` 拷进运行镜像）
- Create: `admin/package.json`、`admin/tsconfig.json`、`admin/vite.config.ts`、`admin/index.html`
- Create: `admin/src/main.tsx`、`admin/src/App.tsx`、`admin/src/routes.tsx`
- Create: `admin/src/theme.ts`、`admin/src/color.ts`、`admin/src/styles.css`
- Create: `admin/src/router.ts`
- Create: `admin/src/api/client.ts`、`admin/src/api/endpoints.ts`
- Create: `admin/src/auth/AuthContext.tsx`、`admin/src/auth/LoginPage.tsx`
- Create: `admin/src/layout/AppLayout.tsx`、`admin/src/layout/ViewOptions.tsx`
- Create（分支 A）: `admin/public/fonts/HarmonyOS_Sans_SC_Regular.woff2`、`admin/public/fonts/HarmonyOS_Sans_SC_Medium.woff2`、`admin/public/fonts/LICENSE.txt`
- Test: `admin/test/setup.ts`、`admin/test/helpers.tsx`、`admin/test/client.test.ts`、`admin/test/theme.test.ts`、`admin/test/router.test.ts`、`admin/test/auth.test.tsx`

**Interfaces:**
- Consumes：`@anyidea/protocol` 的 C6 类型 `AdminMe`、`AdminRange`、`AdminOverview`、`AdminOwnerRow`、`AdminOwnerDetail`、`AdminSessionRow`、`AdminTimeline`、`AdminLogRow`、`AdminAuditRow`、`AdminPage`、`AdminError`。spec「后台 HTTP API」表的路径。
- 本任务对后端的**假设**（P2-T2/T3/T4/T5 必须一致；不一致时以后端任务为准，回来改 `endpoints.ts` 一处即可）：
  - 所有路径前缀 `/admin/api`；Cookie 会话；写操作带请求头 `x-csrf-token`，值是 `AdminMe.csrfToken`。
  - `POST /admin/api/login` body `{ password: string }`，成功 200 返回 `AdminMe`；密码错 401、锁定 429，响应体 `AdminError`。
  - `GET /admin/api/me` 未登录返回 401。`POST /admin/api/logout` 返回 204。
  - 列表接口（owners、sessions、logs、audit）返回 `AdminPage<T>`，翻页参数 `cursor`（把上一页的 `nextCursor` 原样传回），每页条数 `limit` 用后端默认值。
  - overview、owners、owner 详情、sessions 支持查询参数 `mock=1`（Q36：默认隐藏 Mock 数据；后端查询 schema 是 strict 的，参数名必须是 `mock`）。sessions 按角色筛选的参数名是 `character`。
  - `GET /admin/api/log-level` 返回 `AdminLogLevelState`；`POST /admin/api/log-level` body `AdminLogLevelRequest`（`level` 可以是 `'reset'`），返回 `AdminLogLevelState`（P2-T1 定义、P2-T5 实现）。
  - `DELETE /admin/api/owners/:oid` body `AdminDeleteOwnerRequest`（`{ confirm: <oid> }`），返回 204。
  - 告警：`AdminOverview.alerts[].value` / `threshold`，`error_rate_1h` 是 0–1 小数，`first_audio_p95` 是毫秒。`AdminTimeline.firstAudioAlertMs` 是时间线标红的提醒线（毫秒）。
- Produces（P2-T7、P2-T8、P3 的界面任务使用）：
  - `admin/src/api/client.ts`：`AdminApiError`、`createApiClient(options)`、`buildUrl(path, query?)`、类型 `ApiClient`、`Query`
  - `admin/src/api/endpoints.ts`：`adminApi(client)`、类型 `AdminApi`、`SessionQuery`、`LogQuery`、`AuditQuery`、`LogLevelRequest`、`LogLevelResponse`
  - `admin/src/auth/AuthContext.tsx`：`AuthProvider`、`useAuth()`、`useApi()`
  - `admin/src/layout/ViewOptions.tsx`：`ViewOptionsProvider`、`useViewOptions()` → `{ includeMock: boolean; setIncludeMock(v: boolean): void }`
  - `admin/src/router.ts`：`parseHash(hash)`、`useRoute()`、`href(path, query?)`、`navigate(path, query?)`、类型 `Route`
  - `admin/src/layout/AppLayout.tsx`：`AppLayout`、`NAV_GROUPS`（P3 往中间插入「调设置」组）
  - `admin/src/routes.tsx`：`PageRoutes`（P2-T7、P2-T8 在这里接上真正的页面）
  - `admin/src/theme.ts`：`palette`、`FONT_STACK`、`typeScale`、`adminTheme`
  - `admin/src/color.ts`：`contrastRatio(a, b)`
  - `admin/test/helpers.tsx`：`ME`、`fakeFetch(handlers)`、`renderWithProviders(ui, fetchImpl)`

## 设计约束（摘自 spec，实现时逐条对照）

- 色彩（6 个基础色，另加 1 个派生文字色）：

  | 名称 | 色值 | 用途 |
  |---|---|---|
  | 松墨 `ink` | `#24343B` | 正文、标题、侧栏文字 |
  | 青瓷 `celadon` | `#2F6F68` | 主操作、选中态、横条 |
  | 宣白 `paper` | `#F6F8F7` | 页面底色 |
  | 晨雾 `mist` | `#DCE3E1` | 分隔线、边框 |
  | 秋香 `amber` | `#B7791F` | 中风险、「已改未发布」的色条和底色（不做文字色） |
  | 秋香文字 `amberText` | `#8A5A12` | 需要秋香语义的**文字**。`#B7791F` 在宣白上对比度约 3.4，达不到 WCAG AA 的 4.5，所以派生一个加深色，只用于文字 |
  | 朱砂 `cinnabar` | `#B42318` | 高风险、错误、异常标红；只作语义 |

- Ant Design token：`colorPrimary=青瓷`、`colorText=松墨`、`colorBgLayout=宣白`、`colorBorder=晨雾`、`colorWarning=秋香`、`colorError=朱砂`、`borderRadius=6`。
- 字体：一个家族；数字 `tabular-nums`；字号 13 / 15 / 17 / 22 / 30；中文正文行高 1.7；单行不超过约 40 个汉字。**不从网络 CDN 加载字体。**
- 侧栏浅色 208px，分组「看情况」（总览、用户、通话）与「查问题」（排查、审计）；「调设置」组由计划 3 插入两组之间。内容区左对齐，最大宽 1120px。
  - 说明：spec 的布局草图里写的是「会话」，但 spec 文案规则要求用「通话」而不是「session」，界面一律写「通话」。
- 禁用：全大写标签、按钮文字后加「→」、`A · B · C` 式拼接、渐变、统计卡网格、等宽字体小标签、进场动画。尊重 `prefers-reduced-motion`；键盘焦点可见。

## Steps

- [ ] **Step 1: 确认字体许可（A2），选定分支**

打开华为官方的 HarmonyOS Sans 下载与许可页面（开发者联盟「设计 / 资源」中的 HarmonyOS Sans，下载包里附带许可协议文本），阅读许可原文，回答两个问题：
1. 是否允许在本项目的内部后台网页里**自托管**（随网页分发字体文件）？
2. 是否允许把 TTF 转成 WOFF2（属于格式转换，部分许可视为修改）？

两个都允许 → **分支 A**。任一不允许或许可写得不清楚 → **分支 B**。

把结论写进 `docs/blockers.md` 末尾一条新记录（用现有模板），标题「A2 HarmonyOS Sans 许可」，内容写许可原文的出处（下载包里的文件名和条款编号）、结论、选定的分支。分支 B 时状态写「已按 spec 回退，不阻塞」。

- [ ] **Step 2: 根 workspaces 加 admin，建 `admin/package.json`**

修改根 `package.json` 的 `workspaces`：

```json
  "workspaces": ["protocol", "gateway", "avatar-core", "admin"],
```

新建 `admin/package.json`：

```json
{
  "name": "@anyidea/admin",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@anyidea/protocol": "*"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "vite": "8.3.4",
    "vitest": "5.0.3"
  }
}
```

`typescript`、`vite`、`vitest` 与 `avatar-core` 的版本保持一致，不另选。

- [ ] **Step 3: 用精确版本安装其余依赖**

先确认 `@vitejs/plugin-react` 当前版本支持 vite 8：

```bash
npm view @vitejs/plugin-react version peerDependencies
```

预期：输出的 `peerDependencies.vite` 范围包含 `^8`。不包含时，用 `npm view @vitejs/plugin-react versions --json` 找到最新一个 peer 范围包含 8 的版本，下面命令里写成 `@vitejs/plugin-react@<那个版本>`。

在仓库根目录执行（`--save-exact` 让 npm 把精确版本写进 `admin/package.json`，不带 `^`）：

```bash
npm install --save-exact -w admin react react-dom antd @ant-design/icons
npm install --save-exact -D -w admin @vitejs/plugin-react @types/react @types/react-dom jsdom @testing-library/react @testing-library/user-event
```

检查：

```bash
grep -nE '"[~^]' admin/package.json || echo "all exact"
npm ls -w admin --depth=0
```

预期：输出 `all exact`；`npm ls` 列出上面所有包，没有 `UNMET` 或 `invalid`。`@types/react`、`@types/react-dom` 是 React 的类型声明，属于 React 本身的配套，归在已批准的 React 依赖下；在提交说明里列出。

- [ ] **Step 4: TS、Vite、HTML 配置**

新建 `admin/tsconfig.json`：

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

新建 `admin/vite.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev server only: proxy the admin API to the gateway's loopback admin port.
const adminPort = Number(process.env.ADMIN_PORT ?? '8788');

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: { '/admin/api': { target: `http://127.0.0.1:${adminPort}` } },
  },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  test: { environment: 'jsdom', setupFiles: ['test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'] },
});
```

新建 `admin/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>陪伴值班台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 测试环境与测试辅助**

新建 `admin/test/setup.ts`：

```ts
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  window.localStorage.clear();
});

// jsdom lacks these; Ant Design reads them during layout.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
if (!('ResizeObserver' in window)) {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, 'ResizeObserver', { writable: true, value: NoopResizeObserver });
}
```

新建 `admin/test/helpers.tsx`：

```tsx
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import type { AdminMe } from '@anyidea/protocol';
import { AuthProvider } from '../src/auth/AuthContext.tsx';
import { ViewOptionsProvider } from '../src/layout/ViewOptions.tsx';
import { adminTheme } from '../src/theme.ts';

export const ME: AdminMe = { actor: 'admin', csrfToken: 'csrf-test-1', idleExpiresAt: 1_900_000_000_000 };

export interface FakeResponse { status?: number; body?: unknown }
export type Handler = (url: URL, init: RequestInit) => FakeResponse | Promise<FakeResponse>;
export interface FakeCall { method: string; url: URL; init: RequestInit }

/**
 * Keys are "<METHOD> <pathname>", e.g. "GET /admin/api/overview".
 * A plain value is returned as a 200 JSON body; a function decides status and body.
 * "GET /admin/api/me" defaults to ME.
 */
export function fakeFetch(handlers: Record<string, Handler | FakeResponse['body']>): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, init });
    const key = `${method} ${url.pathname}`;
    const handler = key in handlers ? handlers[key] : key === 'GET /admin/api/me' ? ME : undefined;
    if (handler === undefined) return json(404, { error: 'not_found', message: '找不到要查看的内容，可能已被删除。' });
    const result = typeof handler === 'function' ? await (handler as Handler)(url, init) : { body: handler };
    if (result.status === 204) return new Response(null, { status: 204 });
    return json(result.status ?? 200, result.body ?? {});
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function renderWithProviders(ui: ReactElement, fetchImpl: typeof fetch) {
  return render(
    <ConfigProvider theme={adminTheme} button={{ autoInsertSpace: false }}>
      <AntApp>
        <AuthProvider fetchImpl={fetchImpl}>
          <ViewOptionsProvider>{ui}</ViewOptionsProvider>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>,
  );
}
```

- [ ] **Step 6: 写失败的 API 客户端测试**

新建 `admin/test/client.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { AdminApiError, buildUrl, createApiClient } from '../src/api/client.ts';
import { fakeFetch } from './helpers.tsx';

describe('buildUrl', () => {
  it('prefixes /admin/api and drops empty query values', () => {
    expect(buildUrl('/sessions', { oid: 'abc', cursor: null, character: '', mock: undefined, from: 0 })).toBe('/admin/api/sessions?oid=abc&from=0');
    expect(buildUrl('/me')).toBe('/admin/api/me');
  });
});

describe('createApiClient', () => {
  it('sends the CSRF header on writes only', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/owners': { items: [], nextCursor: null }, 'POST /admin/api/owners/abc/ban': () => ({ status: 204 }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => 'csrf-9', onUnauthorized: () => {} });
    await client.get('/owners');
    await client.post('/owners/abc/ban');
    const get = new Headers(calls[0]!.init.headers);
    const post = new Headers(calls[1]!.init.headers);
    expect(get.get('x-csrf-token')).toBeNull();
    expect(post.get('x-csrf-token')).toBe('csrf-9');
    expect(calls[1]!.init.credentials).toBe('same-origin');
  });

  it('calls onUnauthorized on a 401 outside login', async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch({ 'GET /admin/api/overview': () => ({ status: 401, body: { error: 'unauthorized', message: '登录已过期，请重新登录。' } }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => null, onUnauthorized });
    await expect(client.get('/overview')).rejects.toBeInstanceOf(AdminApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('treats a login 401 as a wrong password, not an expired session', async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch({ 'POST /admin/api/login': () => ({ status: 401, body: {} }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => null, onUnauthorized });
    const error = await client.post('/login', { password: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as AdminApiError).message).toBe('密码不对，请重新输入。');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('prefers the server message and code', async () => {
    const { fetch } = fakeFetch({ 'POST /admin/api/login': () => ({ status: 429, body: { error: 'login_locked', message: '密码错误次数太多，请 15 分钟后再试。' } }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => null, onUnauthorized: () => {} });
    const error = (await client.post('/login', { password: 'x' }).catch((e: unknown) => e)) as AdminApiError;
    expect(error.status).toBe(429);
    expect(error.code).toBe('login_locked');
    expect(error.message).toBe('密码错误次数太多，请 15 分钟后再试。');
  });

  it('turns a network failure into a readable error', async () => {
    const failing = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const client = createApiClient({ fetchImpl: failing, csrfToken: () => null, onUnauthorized: () => {} });
    const error = (await client.get('/me').catch((e: unknown) => e)) as AdminApiError;
    expect(error.code).toBe('network');
    expect(error.message).toBe('连不上后台服务，请确认网关正在运行。');
  });

  it('returns undefined for 204', async () => {
    const { fetch } = fakeFetch({ 'POST /admin/api/logout': () => ({ status: 204 }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => 'c', onUnauthorized: () => {} });
    await expect(client.post('/logout')).resolves.toBeUndefined();
  });
});
```

注意 `fakeFetch` 里 handler 是普通值时整个值都当作 200 的 body；需要指定状态码（例如 204、401）时必须写成函数 `() => ({ status, body })`。

- [ ] **Step 7: 运行，确认失败**

```bash
npm install
npm test -w admin -- test/client.test.ts
```

预期：FAIL，`Failed to resolve import "../src/api/client.ts"`（或 helpers 引用的 `AuthContext.tsx` 不存在）。

- [ ] **Step 8: 实现 API 客户端与接口表**

新建 `admin/src/api/client.ts`：

```ts
import type { AdminError } from '@anyidea/protocol';

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface ApiClient {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  csrfToken: () => string | null;
  onUnauthorized: () => void;
}

const NETWORK_MESSAGE = '连不上后台服务，请确认网关正在运行。';
const LOGIN_FAILED_MESSAGE = '密码不对，请重新输入。';
const DEFAULT_MESSAGE = '后台出错了，请稍后再试。';
const STATUS_MESSAGES: Record<number, string> = {
  401: '登录已过期，请重新登录。',
  403: '没有权限做这个操作。',
  404: '找不到要查看的内容，可能已被删除。',
  409: '数据已在别处更新，请刷新后再试。',
  429: '操作太频繁，请稍后再试。',
};

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `/admin/api${path}${qs ? `?${qs}` : ''}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  // Wrap the global so it is never called with a foreign `this`.
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function send<T>(method: 'GET' | 'POST' | 'DELETE', path: string, query?: Query, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') {
      const token = options.csrfToken();
      if (token) headers['x-csrf-token'] = token;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(buildUrl(path, query), {
        method,
        headers,
        credentials: 'same-origin',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AdminApiError(0, 'network', NETWORK_MESSAGE);
    }
    const isLogin = path === '/login';
    if (response.status === 401 && !isLogin) options.onUnauthorized();
    if (!response.ok) {
      let payload: Partial<AdminError> = {};
      try {
        payload = (await response.json()) as Partial<AdminError>;
      } catch {
        // Non-JSON error body: fall back to the status message.
      }
      const fallback = isLogin && response.status === 401 ? LOGIN_FAILED_MESSAGE : STATUS_MESSAGES[response.status] ?? DEFAULT_MESSAGE;
      throw new AdminApiError(response.status, payload.error ?? `http_${response.status}`, payload.message || fallback);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    get: (path, query) => send('GET', path, query),
    post: (path, body) => send('POST', path, undefined, body ?? {}),
    del: (path, body) => send('DELETE', path, undefined, body),
  };
}
```

新建 `admin/src/api/endpoints.ts`：

```ts
import type {
  AdminAuditRow,
  AdminDeleteOwnerRequest,
  AdminLoginRequest,
  AdminLogLevel,
  AdminLogLevelRequest,
  AdminLogLevelState,
  AdminLogRow,
  AdminMe,
  AdminOverview,
  AdminOwnerDetail,
  AdminOwnerRow,
  AdminPage,
  AdminRange,
  AdminSessionRow,
  AdminTimeline,
} from '@anyidea/protocol';
import type { ApiClient } from './client.ts';

export type LogLevelName = AdminLogLevel;

export interface SessionQuery { oid?: string; character?: string; from?: number; to?: number; cursor?: string | null; includeMock: boolean }
export interface LogQuery { sid?: string; oid?: string; event?: string; level?: LogLevelName; from?: number; to?: number; cursor?: string | null }
export interface AuditQuery { action?: string; from?: number; to?: number; cursor?: string | null }
// The backend query schemas are strict: the flag must be sent as `mock=1`, or omitted.
const mock = (includeMock: boolean) => (includeMock ? 1 : undefined);
const seg = (value: string) => encodeURIComponent(value);

/** One place that maps screens to admin API routes (spec「后台 HTTP API」). */
export function adminApi(client: ApiClient) {
  return {
    me: () => client.get<AdminMe>('/me'),
    login: (password: string) => client.post<AdminMe>('/login', { password } satisfies AdminLoginRequest),
    logout: () => client.post<void>('/logout'),
    overview: (range: AdminRange, includeMock: boolean) => client.get<AdminOverview>('/overview', { range, mock: mock(includeMock) }),
    owners: (cursor: string | null, includeMock: boolean) => client.get<AdminPage<AdminOwnerRow>>('/owners', { cursor, mock: mock(includeMock) }),
    owner: (oid: string, includeMock: boolean) => client.get<AdminOwnerDetail>(`/owners/${seg(oid)}`, { mock: mock(includeMock) }),
    banOwner: (oid: string) => client.post<void>(`/owners/${seg(oid)}/ban`),
    unbanOwner: (oid: string) => client.post<void>(`/owners/${seg(oid)}/unban`),
    deleteOwner: (oid: string) => client.del<void>(`/owners/${seg(oid)}`, { confirm: oid } satisfies AdminDeleteOwnerRequest),
    sessions: (q: SessionQuery) =>
      client.get<AdminPage<AdminSessionRow>>('/sessions', { oid: q.oid, character: q.character, from: q.from, to: q.to, cursor: q.cursor, mock: mock(q.includeMock) }),
    timeline: (sid: string) => client.get<AdminTimeline>(`/sessions/${seg(sid)}/timeline`),
    logs: (q: LogQuery) => client.get<AdminPage<AdminLogRow>>('/logs', { sid: q.sid, oid: q.oid, event: q.event, level: q.level, from: q.from, to: q.to, cursor: q.cursor }),
    logLevel: () => client.get<AdminLogLevelState>('/log-level'),
    setLogLevel: (body: AdminLogLevelRequest) => client.post<AdminLogLevelState>('/log-level', body),
    audit: (q: AuditQuery) => client.get<AdminPage<AdminAuditRow>>('/audit', { action: q.action, from: q.from, to: q.to, cursor: q.cursor }),
  };
}

export type AdminApi = ReturnType<typeof adminApi>;
```

- [ ] **Step 9: 写失败的主题、路由、登录测试**

新建 `admin/test/theme.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/color.ts';
import { adminTheme, palette, typeScale } from '../src/theme.ts';

describe('design tokens', () => {
  it('map the spec palette onto Ant Design tokens', () => {
    expect(adminTheme.token).toMatchObject({
      colorPrimary: '#2F6F68',
      colorText: '#24343B',
      colorBgLayout: '#F6F8F7',
      colorBorder: '#DCE3E1',
      colorWarning: '#B7791F',
      colorError: '#B42318',
      borderRadius: 6,
      fontSize: 15,
    });
    expect(typeScale).toEqual({ caption: 13, body: 15, rowTitle: 17, pageTitle: 22, brief: 30 });
  });

  it('keep every text colour at WCAG AA on the page and on white', () => {
    for (const text of [palette.ink, palette.celadon, palette.cinnabar, palette.amberText]) {
      expect(contrastRatio(text, palette.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(text, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    }
    // Primary buttons: white label on celadon.
    expect(contrastRatio('#FFFFFF', palette.celadon)).toBeGreaterThanOrEqual(4.5);
  });

  it('does not use the bar-only amber as a text colour', () => {
    expect(contrastRatio(palette.amber, palette.paper)).toBeLessThan(4.5);
  });
});
```

新建 `admin/test/router.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { href, parseHash } from '../src/router.ts';

describe('hash router', () => {
  it('defaults to the overview', () => {
    expect(parseHash('').path).toBe('/overview');
    expect(parseHash('#').path).toBe('/overview');
  });

  it('splits segments and query', () => {
    const route = parseHash('#/trace/1b4e28ba-2fa1-11d2-883f-0016d3cca427?level=error');
    expect(route.segments).toEqual(['trace', '1b4e28ba-2fa1-11d2-883f-0016d3cca427']);
    expect(route.query.get('level')).toBe('error');
  });

  it('builds hrefs with encoded query', () => {
    expect(href('/sessions', { oid: 'abc', char: '' })).toBe('#/sessions?oid=abc');
    expect(href('/users/abc')).toBe('#/users/abc');
  });
});
```

新建 `admin/test/auth.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App.tsx';
import { useApi } from '../src/auth/AuthContext.tsx';
import { ME, fakeFetch, renderWithProviders } from './helpers.tsx';

const anonymous = { 'GET /admin/api/me': () => ({ status: 401, body: { error: 'unauthorized', message: '登录已过期，请重新登录。' } }) };

describe('login', () => {
  it('shows the login form when there is no session', async () => {
    const { fetch } = fakeFetch(anonymous);
    renderWithProviders(<App />, fetch);
    expect(await screen.findByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('shows the server message when the password is wrong and clears the field', async () => {
    const { fetch } = fakeFetch({
      ...anonymous,
      'POST /admin/api/login': () => ({ status: 401, body: { error: 'login_failed', message: '密码不对，请重新输入。' } }),
    });
    renderWithProviders(<App />, fetch);
    const input = (await screen.findByLabelText('密码')) as HTMLInputElement;
    await userEvent.type(input, 'wrong{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('密码不对，请重新输入。');
    expect(input.value).toBe('');
  });

  it('asks for a password before calling the server', async () => {
    const { fetch, calls } = fakeFetch(anonymous);
    renderWithProviders(<App />, fetch);
    await userEvent.click(await screen.findByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toBe('请输入密码。');
    expect(calls.some((c) => c.url.pathname === '/admin/api/login')).toBe(false);
  });

  it('enters the console after a correct password, by keyboard only', async () => {
    let signedIn = false;
    const { fetch } = fakeFetch({
      'GET /admin/api/me': () => (signedIn ? { body: ME } : { status: 401, body: {} }),
      'POST /admin/api/login': () => {
        signedIn = true;
        return { body: ME };
      },
    });
    renderWithProviders(<App />, fetch);
    await screen.findByLabelText('密码');
    await userEvent.keyboard('right-password{Enter}');
    expect(await screen.findByText('看情况')).toBeTruthy();
    expect(screen.getByText('查问题')).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
  });

  it('returns to the login form when any call answers 401', async () => {
    function Probe() {
      const api = useApi();
      return <button onClick={() => void api.owners(null, false).catch(() => {})}>probe</button>;
    }
    const { fetch } = fakeFetch({ 'GET /admin/api/owners': () => ({ status: 401, body: {} }) });
    renderWithProviders(
      <>
        <App />
        <Probe />
      </>,
      fetch,
    );
    expect(await screen.findByText('看情况')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'probe' }));
    await waitFor(() => expect(screen.getByLabelText('密码')).toBeTruthy());
  });
});
```

`enters the console` 用例验证「键盘可完成登录」：密码框 `autoFocus`，直接键入后回车提交。

- [ ] **Step 10: 运行，确认失败**

```bash
npm test -w admin
```

预期：FAIL，找不到 `../src/color.ts`、`../src/theme.ts`、`../src/router.ts`、`../src/App.tsx`。

- [ ] **Step 11: 实现主题与颜色工具**

新建 `admin/src/color.ts`：

```ts
/** WCAG 2.x relative luminance contrast between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`bad_colour:${hex}`);
  const n = parseInt(match[1]!, 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
```

新建 `admin/src/theme.ts`（分支 A 的 `FONT_STACK`；分支 B 去掉第一项 `"HarmonyOS Sans SC", `）：

```ts
import type { ThemeConfig } from 'antd';

/** spec「界面设计 / 色彩」. amberText is derived: amber itself fails AA as text. */
export const palette = {
  ink: '#24343B',
  celadon: '#2F6F68',
  paper: '#F6F8F7',
  mist: '#DCE3E1',
  amber: '#B7791F',
  amberText: '#8A5A12',
  cinnabar: '#B42318',
  white: '#FFFFFF',
  celadonTint: '#E6EFED',
} as const;

export const FONT_STACK = '"HarmonyOS Sans SC", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';

export const typeScale = { caption: 13, body: 15, rowTitle: 17, pageTitle: 22, brief: 30 } as const;

export const adminTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.celadon,
    colorText: palette.ink,
    colorBgLayout: palette.paper,
    colorBorder: palette.mist,
    colorWarning: palette.amber,
    colorError: palette.cinnabar,
    colorLink: palette.celadon,
    borderRadius: 6,
    fontFamily: FONT_STACK,
    fontSize: typeScale.body,
    lineHeight: 1.7,
  },
  components: {
    Layout: { siderBg: palette.white, bodyBg: palette.paper, headerBg: palette.paper },
    Menu: { itemSelectedBg: palette.celadonTint, itemSelectedColor: palette.celadon, groupTitleColor: palette.ink },
    Table: { headerBg: palette.paper },
  },
};
```

`celadonTint` 只用作选中项底色，`white` 是侧栏底色；两者都是背景，不参与文字对比度。

- [ ] **Step 12: 字体文件与全局样式**

**分支 A**：
1. 从 Step 1 读过许可的那个官方下载包里取 `HarmonyOS_Sans_SC_Regular.ttf` 和 `HarmonyOS_Sans_SC_Medium.ttf`。
2. 用 Google 的 `woff2` 工具转换（只是执行机上的一次性工具，不是项目依赖）：
   ```bash
   brew install woff2
   mkdir -p admin/public/fonts
   woff2_compress /path/to/HarmonyOS_Sans_SC_Regular.ttf
   woff2_compress /path/to/HarmonyOS_Sans_SC_Medium.ttf
   mv /path/to/HarmonyOS_Sans_SC_Regular.woff2 /path/to/HarmonyOS_Sans_SC_Medium.woff2 admin/public/fonts/
   ```
3. 把下载包里的许可协议文本原样拷成 `admin/public/fonts/LICENSE.txt`。
4. `ls -l admin/public/fonts` 记下两个文件的大小，写进提交说明。

**分支 B**：不放字体文件，不建 `admin/public/fonts/`；`styles.css` 里删掉两个 `@font-face` 块，`theme.ts` 的 `FONT_STACK` 去掉 HarmonyOS 一项（Step 11 已说明）。

新建 `admin/src/styles.css`（分支 A 全文；分支 B 删掉开头两个 `@font-face`）：

```css
@font-face {
  font-family: "HarmonyOS Sans SC";
  src: url("/fonts/HarmonyOS_Sans_SC_Regular.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "HarmonyOS Sans SC";
  src: url("/fonts/HarmonyOS_Sans_SC_Medium.woff2") format("woff2");
  font-weight: 500 600;
  font-display: swap;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background: #f6f8f7;
  color: #24343b;
  font-size: 15px;
  line-height: 1.7;
  font-variant-numeric: tabular-nums;
}

h1,
h2,
h3 {
  font-weight: 600;
  margin: 0;
}

:focus-visible {
  outline: 2px solid #2f6f68;
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/* About 40 CJK characters per line (spec: 字体). */
.prose {
  max-width: 40em;
}

.caption {
  font-size: 13px;
  color: #4d5d63;
}

.page-title {
  font-size: 22px;
  margin-bottom: 24px;
}

.login {
  min-height: 100%;
  display: flex;
  align-items: center;
  padding-left: 12vw;
}

.login form {
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login h1 {
  font-size: 22px;
}

.login-error {
  color: #b42318;
  margin: 0;
}

.content {
  max-width: 1120px;
  padding: 32px 40px 64px;
}
```

`.caption` 的 `#4d5d63` 是松墨在宣白上调浅的辅助色，对比度约 6.3，满足 AA。登录页左对齐（不是居中卡片），与内容区一致。

- [ ] **Step 13: 路由、视图选项、鉴权上下文**

新建 `admin/src/router.ts`：

```ts
import { useEffect, useMemo, useState } from 'react';

export interface Route { path: string; segments: string[]; query: URLSearchParams }

const DEFAULT_PATH = '/overview';

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const path = pathPart === '' || pathPart === '/' ? DEFAULT_PATH : pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path, segments: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(queryPart) };
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value) params.set(key, value);
  const qs = params.toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
}

export function navigate(path: string, query?: Record<string, string | undefined>): void {
  window.location.hash = href(path, query).slice(1);
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return useMemo(() => parseHash(hash), [hash]);
}
```

新建 `admin/src/layout/ViewOptions.tsx`：

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface ViewOptions { includeMock: boolean; setIncludeMock(value: boolean): void }

const STORAGE_KEY = 'admin.includeMock';
const ViewOptionsContext = createContext<ViewOptions | null>(null);

/** Mock usage is hidden by default (spec Q36); the choice survives a reload. */
export function ViewOptionsProvider({ children }: { children: ReactNode }) {
  const [includeMock, setState] = useState(() => window.localStorage.getItem(STORAGE_KEY) === '1');
  const setIncludeMock = useCallback((value: boolean) => {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    setState(value);
  }, []);
  const value = useMemo(() => ({ includeMock, setIncludeMock }), [includeMock, setIncludeMock]);
  return <ViewOptionsContext.Provider value={value}>{children}</ViewOptionsContext.Provider>;
}

export function useViewOptions(): ViewOptions {
  const value = useContext(ViewOptionsContext);
  if (!value) throw new Error('ViewOptionsProvider missing');
  return value;
}
```

新建 `admin/src/auth/AuthContext.tsx`：

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminMe } from '@anyidea/protocol';
import { createApiClient } from '../api/client.ts';
import { adminApi, type AdminApi } from '../api/endpoints.ts';

export type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'signed-in'; me: AdminMe };

interface AuthValue {
  state: AuthState;
  api: AdminApi;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  // The CSRF token lives only in memory; a reload asks /me again.
  const csrf = useRef<string | null>(null);

  const api = useMemo(
    () =>
      adminApi(
        createApiClient({
          ...(fetchImpl ? { fetchImpl } : {}),
          csrfToken: () => csrf.current,
          onUnauthorized: () => {
            csrf.current = null;
            setState({ status: 'anonymous' });
          },
        }),
      ),
    [fetchImpl],
  );

  useEffect(() => {
    let live = true;
    api
      .me()
      .then((me) => {
        if (!live) return;
        csrf.current = me.csrfToken;
        setState({ status: 'signed-in', me });
      })
      .catch(() => {
        if (live) setState({ status: 'anonymous' });
      });
    return () => {
      live = false;
    };
  }, [api]);

  const login = useCallback(
    async (password: string) => {
      const me = await api.login(password);
      csrf.current = me.csrfToken;
      setState({ status: 'signed-in', me });
    },
    [api],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      csrf.current = null;
      setState({ status: 'anonymous' });
    }
  }, [api]);

  const value = useMemo(() => ({ state, api, login, logout }), [state, api, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}

export function useApi(): AdminApi {
  return useAuth().api;
}
```

- [ ] **Step 14: 登录页、布局、路由表、入口**

新建 `admin/src/auth/LoginPage.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import { Button, Input } from 'antd';
import { AdminApiError } from '../api/client.ts';
import { useAuth } from './AuthContext.tsx';

export function LoginPage() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError('请输入密码。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : '登录失败，请稍后再试。');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} aria-labelledby="login-title" noValidate>
        <h1 id="login-title">陪伴值班台</h1>
        <p className="caption">输入管理员密码后进入。</p>
        <label htmlFor="admin-password">密码</label>
        <Input.Password
          id="admin-password"
          autoFocus
          autoComplete="current-password"
          value={password}
          status={error ? 'error' : ''}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p role="alert" className="login-error">
            {error}
          </p>
        )}
        <Button type="primary" htmlType="submit" loading={busy} block>
          登录
        </Button>
      </form>
    </main>
  );
}
```

新建 `admin/src/layout/AppLayout.tsx`：

```tsx
import type { ReactNode } from 'react';
import { Button, Layout, Menu, Switch } from 'antd';
import { useAuth } from '../auth/AuthContext.tsx';
import { navigate, useRoute } from '../router.ts';
import { useViewOptions } from './ViewOptions.tsx';

export interface NavItem { path: string; label: string }
export interface NavGroup { title: string; items: NavItem[] }

/** Grouped by task (spec「布局」). Plan 3 inserts 调设置 between the two groups. */
export const NAV_GROUPS: NavGroup[] = [
  { title: '看情况', items: [{ path: '/overview', label: '总览' }, { path: '/users', label: '用户' }, { path: '/sessions', label: '通话' }] },
  { title: '查问题', items: [{ path: '/trace', label: '排查' }, { path: '/audit', label: '审计' }] },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const { logout } = useAuth();
  const { includeMock, setIncludeMock } = useViewOptions();
  const top = `/${route.segments[0] ?? 'overview'}`;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={208} theme="light" style={{ borderRight: '1px solid #DCE3E1' }}>
        <div style={{ padding: '24px 24px 16px', fontSize: 17, fontWeight: 600 }}>陪伴值班台</div>
        <Menu
          mode="inline"
          selectedKeys={[top]}
          onClick={({ key }) => navigate(String(key))}
          items={NAV_GROUPS.map((group) => ({
            type: 'group' as const,
            key: group.title,
            label: group.title,
            children: group.items.map((item) => ({ key: item.path, label: item.label })),
          }))}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 24, padding: '0 40px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch size="small" checked={includeMock} onChange={setIncludeMock} aria-label="显示模拟数据" />
            <span className="caption">显示模拟数据</span>
          </label>
          <Button onClick={() => void logout()}>退出登录</Button>
        </Layout.Header>
        <Layout.Content>
          <div className="content">{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
```

新建 `admin/src/routes.tsx`（本任务先给每个入口一个只有标题的页面；P2-T7、P2-T8 换成真正的页面）：

```tsx
import { useRoute } from './router.ts';

function TitleOnly({ title }: { title: string }) {
  return <h1 className="page-title">{title}</h1>;
}

/** Route table. P2-T7/P2-T8 replace each TitleOnly with the real page. */
export function PageRoutes() {
  const route = useRoute();
  switch (route.segments[0]) {
    case 'users':
      return <TitleOnly title="用户" />;
    case 'sessions':
      return <TitleOnly title="通话" />;
    case 'trace':
      return <TitleOnly title="排查" />;
    case 'audit':
      return <TitleOnly title="审计" />;
    default:
      return <TitleOnly title="总览" />;
  }
}
```

新建 `admin/src/App.tsx`：

```tsx
import { Spin } from 'antd';
import { useAuth } from './auth/AuthContext.tsx';
import { LoginPage } from './auth/LoginPage.tsx';
import { AppLayout } from './layout/AppLayout.tsx';
import { PageRoutes } from './routes.tsx';

export function App() {
  const { state } = useAuth();
  if (state.status === 'loading') return <Spin style={{ margin: 48 }} />;
  if (state.status === 'anonymous') return <LoginPage />;
  return (
    <AppLayout>
      <PageRoutes />
    </AppLayout>
  );
}
```

新建 `admin/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import './styles.css';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import { ViewOptionsProvider } from './layout/ViewOptions.tsx';
import { adminTheme } from './theme.ts';

// Ant Design motion follows the OS setting (spec: 尊重 prefers-reduced-motion).
// autoInsertSpace off: two-character labels stay 「登录」, not 「登 录」.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{ ...adminTheme, token: { ...adminTheme.token, motion: !reducedMotion } }}
      button={{ autoInsertSpace: false }}
    >
      <AntApp>
        <AuthProvider>
          <ViewOptionsProvider>
            <App />
          </ViewOptionsProvider>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
```

- [ ] **Step 15: 运行测试、typecheck、构建**

```bash
npm test -w admin
npm run typecheck -w admin
npm run build -w admin
ls admin/dist
```

预期：测试全部 PASS（client 7、theme 3、router 3、auth 5，共 18）；typecheck 无输出；build 成功，`admin/dist` 里有 `index.html` 和 `assets/`；分支 A 时还有 `fonts/`。`admin/dist` 已被根 `.gitignore` 的 `dist/` 忽略，不提交。

`button={{ autoInsertSpace: false }}` 必须同时出现在 `main.tsx` 和 `test/helpers.tsx`：Ant Design 默认在两个汉字的按钮中间插空格，按钮会显示成「登 录」，既不符合文案，也会让测试按名字找不到按钮。如果当前 Ant Design 版本的 `ConfigProvider` 没有 `button.autoInsertSpace`（`npm view antd version` 低于 5.17），停下报告。

如果 Ant Design 在 jsdom 下报 `getComputedStyle` 或 `matchMedia` 相关错误，只能改 `admin/test/setup.ts` 的兼容桩，不能为了测试改组件。

- [ ] **Step 16: 镜像里打包 `admin/dist`**

把 `Dockerfile.gateway` 改为两阶段（运行阶段内容与原文件一致，只多一行 `COPY --from`）：

```dockerfile
FROM node:24-bookworm-slim AS admin-build

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY protocol/package.json protocol/package.json
COPY admin/package.json admin/package.json
RUN npm ci -w admin -w protocol
COPY protocol protocol
COPY admin admin
RUN npm run build -w admin

FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY protocol/package.json protocol/package.json
COPY gateway/package.json gateway/package.json
RUN npm ci --omit=optional

COPY protocol protocol
COPY gateway gateway
COPY --from=admin-build /app/admin/dist admin/dist

WORKDIR /app/gateway
ENV NODE_ENV=production
CMD ["npm", "run", "start"]
```

构建阶段**不能**带 `--omit=optional`：`typescript`、`vite`（rolldown）和 `lightningcss` 的平台二进制是 optional dependencies，省略后 `tsc` 和 `vite build` 在镜像里会因缺少原生绑定失败。`--omit=optional` 只保留在运行阶段（网关运行不需要这些构建工具）。`@types/node` 是 `admin/` 的精确 devDependency，保证只安装 admin workspace 时 `vite.config.ts` 里的 `process.env` 也能通过 typecheck。

网关的 `staticDir` 指向仓库根的 `admin/dist`（P2-T3 在 `index.ts` 里用 `fileURLToPath(new URL('../../admin/dist', import.meta.url))`），镜像里就是 `/app/admin/dist`。

本机有 docker 时验证：

```bash
docker build -f Dockerfile.gateway -t avatar-gateway:admin-check .
docker run --rm --entrypoint ls avatar-gateway:admin-check /app/admin/dist
```

预期：构建成功；`ls` 列出 `index.html` 和 `assets`。没有 docker：跳过这两条，在进度报告里写「Dockerfile 未在本机构建验证（无 docker）」，并在 P2-T9 的回归里再提醒一次。

- [ ] **Step 17: 自查设计约束**

逐条对照本文件「设计约束」一节，在提交说明里写「已对照」：
- 登录页、侧栏、顶栏没有全大写、`→`、`·` 拼接、渐变、阴影卡片；
- 侧栏是浅色、208px、两组；
- `theme.test.ts` 通过即代表颜色映射与对比度达标；
- 键盘：Tab 能依次到达密码框、登录按钮，焦点有青瓷描边（`npm run dev -w admin` 打开 `http://127.0.0.1:5174` 手动按 Tab 看一次）。

- [ ] **Step 18: 提交**

```bash
git add package.json package-lock.json Dockerfile.gateway admin/package.json admin/tsconfig.json admin/vite.config.ts admin/index.html admin/src admin/test docs/blockers.md
# 分支 A 再加：
git add admin/public/fonts
git commit -m "feat(admin): scaffold the admin console with login and design tokens

New npm workspace admin/ (Vite, React, Ant Design; exact versions).
Adds @types/react and @types/react-dom as React's type packages.
Font: <分支 A：HarmonyOS Sans SC self-hosted, Regular <size> + Medium <size> / 分支 B：system font stack, see blockers A2>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

提交说明里尖括号部分按实际分支写，提交前删掉另一个分支的文字。
