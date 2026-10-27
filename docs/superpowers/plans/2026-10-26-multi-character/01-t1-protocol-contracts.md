# Task 1: 协议契约（角色 id、`ResponseKind`、记忆接口类型）

**目标：** 在 `protocol/` 里建立角色 id 的唯一来源和生成器，补上多角色需要的协议类型（`ResponseKind` 的 `reminder`、`SessionCreateRequest`、记忆接口类型），并从 `session.start` 删除 `voiceProfile`。网关只做最小适配，让 typecheck 和全量测试保持全绿。

**实现的 spec 章节：** 技术设计第 1 节「契约」；范围「契约：角色 id 列表放进 `protocol/`，并生成 Dart 版本」；技术设计第 7 节的响应形状（只定义类型，接口本身在 Task 11）。

**前置：** 无。开始前在仓库根目录跑一次 `npm test -w protocol && npm test -w gateway && npm run typecheck -w gateway`，确认基线全绿。

**Files:**
- Create: `protocol/characters.json`（唯一来源）
- Create: `scripts/generate-character-ids.mjs`（生成器，支持 `--check`）
- Create（生成）: `protocol/src/characters.generated.ts`
- Create（生成）: `app/lib/identity/character_ids.generated.dart`
- Create: `protocol/src/characters.ts`
- Create: `protocol/src/memoryApi.ts`
- Modify: `protocol/src/index.ts`（:13 `ResponseKind`；:23 `session.start`；文件末尾追加 re-export 和 `SessionCreateRequest`）
- Modify: `gateway/src/server/server.ts:392`（`voiceProfile` 读取改为显式的过渡读取）
- Test: `protocol/test/characters.test.ts`（新建）
- Test: `gateway/test/character-ids.test.ts`（新建；生成器 `--check` 需要 node 类型，protocol 包没有 `@types/node`，所以这个检查放在 gateway 测试里）

**Interfaces:**
- Consumes：无。
- Produces（与总览 C1 逐字一致）：
  - `protocol/characters.json`：`{ "ids": ["xiaonuan","xiaokai","xiaoxin"], "defaultId": "xiaonuan" }`
  - `protocol/src/characters.generated.ts`：`CHARACTER_IDS`（`as const`）、`DEFAULT_CHARACTER_ID`
  - `app/lib/identity/character_ids.generated.dart`：`const characterIds = <String>[...]`、`const defaultCharacterId = '...'`
  - `protocol/src/characters.ts`：`export type CharacterId = (typeof CHARACTER_IDS)[number]`；`export function isCharacterId(v: unknown): v is CharacterId`；re-export 生成的常量
  - `ResponseKind = 'reply' | 'greeting' | 'followup' | 'reminder'`
  - `session.start.clientInfo` 不再有 `voiceProfile`
  - `export interface SessionCreateRequest { character?: CharacterId }`
  - `protocol/src/memoryApi.ts`：`MemoryItem`、`MemoryFactItem`、`MemoryPinnedItem`、`MemoryOverview`、`MemoryClearScope`
  - 以上全部经 `protocol/src/index.ts` re-export，下游一律 `import { ... } from '@anyidea/protocol'`

## 调用方适配

`ClientMessage` 删除 `voiceProfile` 之后，只有一处网关代码按协议类型读取它：

| 位置 | 问题 | 最小适配（行为不变） |
|---|---|---|
| `gateway/src/server/server.ts:392` | `msg.clientInfo.voiceProfile` 在类型上不存在了，typecheck 失败 | 改为 `(msg.clientInfo as { voiceProfile?: 'young-male' }).voiceProfile`。`gateway/src/server/schemas.ts:8` 的 zod 字段**保留**，运行时仍然把 App 发来的值传给 `manager.begin`，小凯的年轻男声在 Task 7 之前照常工作。Task 7 删除 zod 字段、这一行和 `manager.begin` 的参数 |

其他引用经核对不受影响：
- `ResponseKind` 的使用方（`gateway/src/session/{director,session,metrics}.ts`、`gateway/src/eval/harness.ts`、`avatar-core/src/app.ts`、`gateway/test/director.test.ts`）只做相等比较或当作透传类型，没有穷举 `switch`，加一个成员不会编译失败。
- `gateway/test/server.test.ts:471-479` 测的是 `parseClientMessage`（zod 结果），zod 字段保留，这个测试不改。
- App 端 `SessionStart.voiceProfile`（`app/lib/native_gateway/protocol.dart:35-51`）由 Task 13 删除，本任务不碰 Dart 业务代码。

## Steps

- [x] **Step 1: 写失败的 protocol 测试**

新建 `protocol/test/characters.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import source from '../characters.json' with { type: 'json' };
import {
  CHARACTER_IDS,
  DEFAULT_CHARACTER_ID,
  isCharacterId,
  type CharacterId,
  type ClientMessage,
  type MemoryClearScope,
  type MemoryOverview,
  type ResponseKind,
  type SessionCreateRequest,
} from '../src/index.ts';

describe('character ids', () => {
  it('come from protocol/characters.json in display order', () => {
    expect([...CHARACTER_IDS]).toEqual(source.ids);
    expect(DEFAULT_CHARACTER_ID).toBe(source.defaultId);
    expect([...CHARACTER_IDS]).toEqual(['xiaonuan', 'xiaokai', 'xiaoxin']);
    expect(DEFAULT_CHARACTER_ID).toBe('xiaonuan');
  });

  it('accepts only registered ids', () => {
    for (const id of CHARACTER_IDS) expect(isCharacterId(id)).toBe(true);
    for (const bad of ['lily', 'kai', 'default', '', 'XIAONUAN', ' xiaonuan', 42, null, undefined, {}, ['xiaonuan']]) {
      expect(isCharacterId(bad)).toBe(false);
    }
  });

  it('narrows unknown input to CharacterId', () => {
    const raw: unknown = 'xiaokai';
    if (!isCharacterId(raw)) throw new Error('expected a character id');
    const id: CharacterId = raw;
    expect(id).toBe('xiaokai');
  });
});

describe('multi-character protocol shapes', () => {
  it('adds the reminder response kind', () => {
    const kinds: ResponseKind[] = ['reply', 'greeting', 'followup', 'reminder'];
    expect(kinds).toHaveLength(4);
  });

  it('types the POST /session body with an optional character', () => {
    const chosen: SessionCreateRequest = { character: 'xiaokai' };
    const fallback: SessionCreateRequest = {};
    expect(chosen.character).toBe('xiaokai');
    expect(fallback.character).toBeUndefined();
  });

  it('types the memory overview returned by GET /memory', () => {
    const scope: MemoryClearScope = 'character';
    const overview: MemoryOverview = {
      profile: { addressing: { id: 'p1', text: '王叔' }, items: [{ id: 'p2', text: '老家山东' }] },
      characters: [
        { character: 'xiaonuan', pinned: [{ id: 'k1', text: '孙子三月三号生日', sensitive: false }], facts: [{ id: 'f1', text: '膝盖不好', category: 'health', sensitive: true }] },
        { character: 'xiaokai', pinned: [], facts: [] },
        { character: 'xiaoxin', pinned: [], facts: [] },
      ],
    };
    expect(scope).toBe('character');
    expect(overview.characters.map((entry) => entry.character)).toEqual([...CHARACTER_IDS]);
  });

  it('no longer accepts voiceProfile on session.start (checked by typecheck)', () => {
    const start: ClientMessage = {
      type: 'session.start',
      // @ts-expect-error voiceProfile was removed: the voice now follows the character card.
      clientInfo: { platform: 'android', audioPath: 'B', voiceProfile: 'young-male' },
    };
    expect(start.type).toBe('session.start');
  });
});
```

- [x] **Step 2: 跑测试，确认失败**

```bash
npm test -w protocol
```

预期：`protocol/test/characters.test.ts` 失败，报 `Failed to resolve import "../characters.json"`（或找不到 `CHARACTER_IDS` 导出）。

```bash
npm run typecheck -w protocol
```

预期：失败，包含 `Cannot find module '../characters.json'`、`has no exported member 'CHARACTER_IDS'`，以及 `Unused '@ts-expect-error' directive`（`voiceProfile` 还在协议里）。

- [x] **Step 3: 写唯一来源**

新建 `protocol/characters.json`：

```json
{ "ids": ["xiaonuan", "xiaokai", "xiaoxin"], "defaultId": "xiaonuan" }
```

- [x] **Step 4: 写生成器**

新建 `scripts/generate-character-ids.mjs`（参照 `scripts/generate-avatar-catalog.mjs` 的结构）：

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const SOURCE = new URL('../protocol/characters.json', import.meta.url);
const OUTPUTS = [
  ['../protocol/src/characters.generated.ts', renderTs],
  ['../app/lib/identity/character_ids.generated.dart', renderDart],
];
const HEADER = 'Generated from protocol/characters.json by scripts/generate-character-ids.mjs. Do not edit by hand.';

/** The id list is an allowlist shared by gateway and app: reject anything that could widen it silently. */
function validate(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('characters.json must be an object');
  const keys = Object.keys(source).sort();
  if (keys.join(',') !== 'defaultId,ids') throw new Error(`characters.json keys must be exactly ids and defaultId, got: ${keys.join(',')}`);
  if (!Array.isArray(source.ids) || source.ids.length === 0) throw new Error('ids must be a non-empty array');
  const seen = new Set();
  for (const [index, id] of source.ids.entries()) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error(`ids[${index}] is invalid`);
    if (seen.has(id)) throw new Error(`ids[${index}] is duplicated: ${id}`);
    seen.add(id);
  }
  if (typeof source.defaultId !== 'string' || !seen.has(source.defaultId)) throw new Error(`defaultId is not in ids: ${source.defaultId}`);
  return source;
}

// Ids match ID (lowercase ascii, digits, dash), so single quotes never need escaping.
const quoted = (id) => `'${id}'`;

function renderTs(source) {
  return `// ${HEADER}
export const CHARACTER_IDS = [${source.ids.map(quoted).join(', ')}] as const;
export const DEFAULT_CHARACTER_ID: (typeof CHARACTER_IDS)[number] = ${quoted(source.defaultId)};
`;
}

function renderDart(source) {
  return `// ${HEADER}
const characterIds = <String>[${source.ids.map(quoted).join(', ')}];
const defaultCharacterId = ${quoted(source.defaultId)};
`;
}

const source = validate(JSON.parse(readFileSync(SOURCE, 'utf8')));
const check = process.argv.includes('--check');
for (const [relative, render] of OUTPUTS) {
  const target = new URL(relative, import.meta.url);
  const expected = render(source);
  if (check) {
    let actual = '';
    try {
      actual = readFileSync(target, 'utf8');
    } catch {
      throw new Error(`generated character ids are missing: ${fileURLToPath(target)}`);
    }
    if (actual !== expected) throw new Error(`generated character ids are stale: ${fileURLToPath(target)}`);
  } else {
    writeFileSync(target, expected);
  }
}
if (check) console.log('character ids are up to date');
```

- [x] **Step 5: 生成两份文件并核对内容**

```bash
node scripts/generate-character-ids.mjs
cat protocol/src/characters.generated.ts app/lib/identity/character_ids.generated.dart
node scripts/generate-character-ids.mjs --check
```

预期输出（逐字）：

```ts
// Generated from protocol/characters.json by scripts/generate-character-ids.mjs. Do not edit by hand.
export const CHARACTER_IDS = ['xiaonuan', 'xiaokai', 'xiaoxin'] as const;
export const DEFAULT_CHARACTER_ID: (typeof CHARACTER_IDS)[number] = 'xiaonuan';
```

```dart
// Generated from protocol/characters.json by scripts/generate-character-ids.mjs. Do not edit by hand.
const characterIds = <String>['xiaonuan', 'xiaokai', 'xiaoxin'];
const defaultCharacterId = 'xiaonuan';
```

最后一行打印 `character ids are up to date`。

- [x] **Step 6: 写 `characters.ts` 和 `memoryApi.ts`**

新建 `protocol/src/characters.ts`：

```ts
import { CHARACTER_IDS, DEFAULT_CHARACTER_ID } from './characters.generated.ts';

export { CHARACTER_IDS, DEFAULT_CHARACTER_ID };

/** One of the configured companion characters. The list lives in protocol/characters.json. */
export type CharacterId = (typeof CHARACTER_IDS)[number];

export function isCharacterId(v: unknown): v is CharacterId {
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v);
}
```

新建 `protocol/src/memoryApi.ts`：

```ts
import type { CharacterId } from './characters.ts';

/** One deletable memory row as shown in settings. Ids are opaque uuids. */
export interface MemoryItem { id: string; text: string }

export interface MemoryFactItem extends MemoryItem {
  category: 'preference' | 'person' | 'health' | 'other' | 'safety';
  sensitive: boolean;
}

export interface MemoryPinnedItem extends MemoryItem { sensitive: boolean }

/** GET /memory. `characters` lists every character in CHARACTER_IDS order, empty lists for ones never met. */
export interface MemoryOverview {
  profile: { addressing: MemoryItem | null; items: MemoryItem[] };
  characters: Array<{ character: CharacterId; pinned: MemoryPinnedItem[]; facts: MemoryFactItem[] }>;
}

/** DELETE /memory?scope=... */
export type MemoryClearScope = 'profile' | 'character' | 'all';
```

- [x] **Step 7: 改 `protocol/src/index.ts`**

把第 13 行：

```ts
export type ResponseKind = 'reply' | 'greeting' | 'followup';
```

改为：

```ts
/** `reminder` = rest reminder (spec: AI 提示与休息提醒). Clients treat unknown kinds as `reply`. */
export type ResponseKind = 'reply' | 'greeting' | 'followup' | 'reminder';
```

把第 23 行：

```ts
  | { type: 'session.start'; clientInfo: { platform: string; audioPath: AudioPath; language?: Language; voiceProfile?: 'young-male' } }
```

改为：

```ts
  | { type: 'session.start'; clientInfo: { platform: string; audioPath: AudioPath; language?: Language } }
```

在文件最顶部（第 1 行 `export const FRAME_MIC` 之前）加入：

```ts
import type { CharacterId } from './characters.ts';

export { CHARACTER_IDS, DEFAULT_CHARACTER_ID, isCharacterId, type CharacterId } from './characters.ts';
export type { MemoryClearScope, MemoryFactItem, MemoryItem, MemoryOverview, MemoryPinnedItem } from './memoryApi.ts';
```

在 `SessionTokens` 接口之后加入：

```ts
/** POST /session body. A missing character means DEFAULT_CHARACTER_ID (Mock and dev sessions). */
export interface SessionCreateRequest { character?: CharacterId }
```

- [x] **Step 8: 跑 protocol 测试和 typecheck，确认通过**

```bash
npm test -w protocol && npm run typecheck -w protocol
```

预期：`protocol/test/protocol.test.ts` 和 `protocol/test/characters.test.ts` 全部通过；typecheck 无输出、退出码 0（`@ts-expect-error` 现在命中了真实的类型错误）。

- [x] **Step 9: 写失败的网关侧同步测试**

新建 `gateway/test/character-ids.test.ts`：

```ts
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, DEFAULT_CHARACTER_ID } from '@anyidea/protocol';

const repo = fileURLToPath(new URL('../../', import.meta.url));

describe('generated character ids', () => {
  it('are in sync with protocol/characters.json (generator --check)', () => {
    const result = spawnSync(process.execPath, [`${repo}scripts/generate-character-ids.mjs`, '--check'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('character ids are up to date');
  });

  it('give the gateway the same list and default as the json source', () => {
    const source = JSON.parse(readFileSync(`${repo}protocol/characters.json`, 'utf8')) as { ids: string[]; defaultId: string };
    expect([...CHARACTER_IDS]).toEqual(source.ids);
    expect(DEFAULT_CHARACTER_ID).toBe(source.defaultId);
    const dart = readFileSync(`${repo}app/lib/identity/character_ids.generated.dart`, 'utf8');
    expect(dart).toContain(`const characterIds = <String>[${source.ids.map((id) => `'${id}'`).join(', ')}];`);
    expect(dart).toContain(`const defaultCharacterId = '${source.defaultId}';`);
  });
});
```

- [x] **Step 10: 跑网关 typecheck，确认 `server.ts` 失败**

```bash
npm run typecheck -w gateway
```

预期：失败一处，`src/server/server.ts(392,...)`：`Property 'voiceProfile' does not exist on type '{ platform: string; audioPath: AudioPath; language?: Language | undefined; }'`。

- [x] **Step 11: 适配 `server.ts:392`**

把：

```ts
          msg.type === 'session.start' ? msg.clientInfo.voiceProfile : undefined,
```

改为：

```ts
          // Legacy field still parsed by schemas.ts; Task 7 removes voiceProfile end to end.
          msg.type === 'session.start' ? (msg.clientInfo as { voiceProfile?: 'young-male' }).voiceProfile : undefined,
```

- [x] **Step 12: 跑网关全量测试和 typecheck**

```bash
npm test -w gateway -- test/character-ids.test.ts
npm test -w gateway && npm run typecheck -w gateway
```

预期：`character-ids.test.ts` 2 项通过；gateway 全量通过（数量 = 基线 + 2）；typecheck 退出码 0。

- [x] **Step 13: 提交**

```bash
git add protocol/characters.json protocol/src/characters.generated.ts protocol/src/characters.ts protocol/src/memoryApi.ts protocol/src/index.ts protocol/test/characters.test.ts scripts/generate-character-ids.mjs app/lib/identity/character_ids.generated.dart gateway/src/server/server.ts gateway/test/character-ids.test.ts
git commit -m "$(cat <<'EOF'
feat(protocol): add character ids, reminder kind, and memory api types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

（`Co-Authored-By` 行以执行时会话给出的署名为准。）

## 验收清单

- [x] `protocol/characters.json` 是角色 id 的唯一来源；两份生成文件和它一致，`node scripts/generate-character-ids.mjs --check` 打印 `character ids are up to date`。
- [x] `CHARACTER_IDS`、`DEFAULT_CHARACTER_ID`、`CharacterId`、`isCharacterId`、`SessionCreateRequest`、`MemoryOverview` 等都能从 `@anyidea/protocol` 导入。
- [x] `ResponseKind` 含 `reminder`；`session.start.clientInfo` 没有 `voiceProfile`（`@ts-expect-error` 测试由 typecheck 保证）。
- [x] 网关只改了 `server.ts:392` 一行；小凯的音色在 Task 7 之前行为不变。
- [x] 没有改 App 的 Dart 业务代码（只新增生成文件）。

全量命令（仓库根目录）：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
node scripts/generate-character-ids.mjs --check
cd app && flutter analyze   # the new generated Dart file must be lint-clean; nothing imports it yet
```
