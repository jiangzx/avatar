import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentityConfig } from '../../gateway/src/config.ts';
import { DeviceRegistry } from '../../gateway/src/identity/registry.ts';
import { openDatabase } from '../../gateway/src/memory/db.ts';
import { loadExtractPrompt } from '../../gateway/src/memory/extract.ts';
import { SqliteMemoryStore } from '../../gateway/src/memory/store.ts';
import { QwenTextClient } from '../../gateway/src/memory/textClient.ts';
import { MemoryWorker } from '../../gateway/src/memory/worker.ts';
import { SqliteTranscriptWriter } from '../../gateway/src/memory/writer.ts';
import { errorCodeOf } from '../../gateway/src/reliability/policy.ts';
import { loadRoleCatalog } from '../../gateway/src/roles/fileCatalog.ts';
import { buildInstructions } from '../../gateway/src/session/instructions.ts';
import { loadMemoryBudget } from '../../gateway/src/session/pacing.ts';

// Explicit live probe: node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-qwen-memory-probe.mjs
// Synthetic inputs only. Notice completion is simulated; no voice call or audio storage.
function check(value, code) {
  if (!value) throw new Error(code);
}

async function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const memory = loadMemoryBudget(join(root, 'gateway/config/memory.json'));
  const temp = mkdtempSync(join(tmpdir(), 'avatar-qwen-memory-'));
  const path = join(temp, 'memory.db');
  let db;
  const started = performance.now();
  const stats = { calls: 0, responseBytes: 0 };
  try {
    check(process.env.DASHSCOPE_API_KEY, 'probe_key_missing');
    let endpoint = process.env.QWEN_SUMMARIZER_ENDPOINT;
    if (!endpoint) {
      const realtime = new URL(process.env.QWEN_ENDPOINT);
      check(/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(realtime.hostname), 'probe_workspace_missing');
      // Same-workspace endpoint format verified in docs/research/qwen-text-summarizer.md.
      endpoint = `https://${realtime.hostname}/compatible-mode/v1/chat/completions`;
    }
    const identity = loadIdentityConfig({ ...process.env, MEMORY_DB_PATH: path }, root);
    const roles = loadRoleCatalog(join(root, 'gateway/roles'));
    const registryFor = store => new DeviceRegistry({
      store,
      roles,
      limits: {
        maxOwners: identity.maxOwners,
        dailyCap: identity.registerDailyCap,
        orphanOwnerDays: identity.orphanOwnerDays,
        orphanCleanupBatch: identity.orphanCleanupBatch,
      },
    });
    db = openDatabase(path, { busyTimeoutMs: identity.busyTimeoutMs });
    const store = new SqliteMemoryStore(db);
    const registry = registryFor(store);
    const a = registry.register(undefined);
    const b = registry.register(undefined);
    check(a.ok && b.ok, 'probe_registration_failed');
    const first = registry.resolve(a.deviceToken);
    check(first.ok && first.ctx.ownerId, 'probe_owner_missing');
    const ownerId = first.ctx.ownerId;
    const sessionId = randomUUID();
    const writer = new SqliteTranscriptWriter(store);
    const user = '我姓王，您叫我王叔就好。我喜欢喝茶。';
    const append = (role, text) => writer.append({ ownerId, sessionId, role, text, now: Date.now() });
    check(append('user', user) === 'skipped', 'probe_notice_gate_failed');
    writer.markNotified(ownerId, Date.now());
    check(append('user', user) === 'stored', 'probe_user_write_failed');
    check(append('assistant', '好，王叔。') === 'stored', 'probe_assistant_write_failed');
    const client = new QwenTextClient({ apiKey: process.env.DASHSCOPE_API_KEY, endpoint, model: memory.extractModel });
    const worker = new MemoryWorker({
      store,
      client: {
        async complete(input) {
          stats.calls += 1;
          const content = await client.complete(input);
          stats.responseBytes += Buffer.byteLength(content);
          return content;
        },
      },
      systemPrompt: loadExtractPrompt(),
      maxTokens: memory.extractMaxTokens,
      policy: memory.extractPolicy,
      transcriptMaxChars: memory.extractTranscriptMaxChars,
      contextMaxChars: memory.extractContextMaxChars,
    });
    await worker.extractOwner(ownerId, 'session_end');
    const messages = db.prepare('SELECT count(*) AS total, sum(extracted) AS extracted FROM messages WHERE owner_id = ?').get(ownerId);
    stats.messages = messages.total;
    stats.extracted = messages.extracted;
    stats.facts = store.listFacts(ownerId).length;
    const facts = store.listFacts(ownerId);
    stats.addressingFacts = facts.filter(fact => fact.category === 'addressing').length;
    stats.addressingNameMatches = facts.filter(fact => fact.category === 'addressing' && fact.text.includes('王叔')).length;
    stats.nameMatches = facts.filter(fact => fact.text.includes('王叔')).length;
    stats.preferenceMatches = facts.filter(fact => fact.category === 'preference' && fact.text.includes('喝茶')).length;
    check(messages.total === 2 && messages.extracted === 2, 'probe_extraction_not_applied');
    check(store.listPendingMessages(ownerId).length === 0, 'probe_tail_not_extracted');
    check(facts.some(fact => fact.category === 'addressing' && fact.text.includes('王叔')), 'probe_addressing_missing');
    check(facts.some(fact => fact.category === 'preference' && fact.text.includes('喝茶')), 'probe_preference_missing');
    db.close();
    db = openDatabase(path, { busyTimeoutMs: identity.busyTimeoutMs });
    const reopened = registryFor(new SqliteMemoryStore(db));
    const again = reopened.resolve(a.deviceToken);
    const other = reopened.resolve(b.deviceToken);
    check(again.ok && again.ctx.memorySnapshot?.includes('王叔') && again.ctx.memorySnapshot.includes('喝茶'), 'probe_snapshot_missing');
    check(other.ok && !other.ctx.memorySnapshot, 'probe_owner_isolation_failed');
    const instructions = buildInstructions({
      persona: roles.buildPersona(again.ctx.roleId, again.ctx.styleId),
      memorySnapshot: again.ctx.memorySnapshot,
      summary: '',
      recent: [],
    });
    check(instructions.includes('## 关于用户（记忆）') && instructions.includes('王叔'), 'probe_instructions_missing');
    console.log(JSON.stringify({ event: 'qwen_memory_probe', ok: true, ...stats, persistedSnapshot: true, ownerIsolated: true, ms: Math.round(performance.now() - started) }));
  } catch (error) {
    console.log(JSON.stringify({ event: 'qwen_memory_probe', ok: false, code: errorCodeOf(error), ...stats, ms: Math.round(performance.now() - started) }));
    process.exitCode = 1;
  } finally {
    if (db?.isOpen) db.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
