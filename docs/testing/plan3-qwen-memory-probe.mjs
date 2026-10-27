import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '@anyidea/protocol';
import { loadCharacterRegistry } from '../../gateway/src/characters/registry.ts';
import { loadIdentityConfig } from '../../gateway/src/config.ts';
import { loadI18n } from '../../gateway/src/i18n/load.ts';
import { DeviceRegistry } from '../../gateway/src/identity/registry.ts';
import { openDatabase } from '../../gateway/src/memory/db.ts';
import { SqliteMemoryStore } from '../../gateway/src/memory/store.ts';
import { QwenTextClient } from '../../gateway/src/memory/textClient.ts';
import { MemoryWorker } from '../../gateway/src/memory/worker.ts';
import { SqliteTranscriptWriter } from '../../gateway/src/memory/writer.ts';
import { errorCodeOf } from '../../gateway/src/reliability/policy.ts';
import { loadRoleCatalog } from '../../gateway/src/roles/fileCatalog.ts';
import { PROMPT_LABELS } from '../../gateway/src/roles/labels.ts';
import { buildInstructions } from '../../gateway/src/session/instructions.ts';
import { loadMemoryBudget, loadPacing } from '../../gateway/src/session/pacing.ts';
import { sourceRate } from '../../gateway/scripts/lib/multi-character-verdicts.ts';

// Explicit live probe: node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan3-qwen-memory-probe.mjs
// Synthetic inputs only. Notice completion is simulated; no voice call or audio storage.
function check(value, code) {
  if (!value) throw new Error(code);
}

async function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const memory = loadMemoryBudget(join(root, 'gateway/config/memory.json'));
  const pacing = loadPacing(join(root, 'gateway/config/pacing.json'));
  const characters = loadCharacterRegistry(join(root, 'gateway/characters'), LANGUAGES);
  const roles = loadRoleCatalog(join(root, 'gateway/roles'), characters);
  const i18n = loadI18n(join(root, 'gateway/config'));
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
    const registryFor = store => new DeviceRegistry({
      store,
      roles,
      characters,
      limits: {
        maxOwners: identity.maxOwners,
        dailyCap: identity.registerDailyCap,
        orphanOwnerDays: identity.orphanOwnerDays,
        orphanCleanupBatch: identity.orphanCleanupBatch,
      },
      continuityGapMs: pacing.restReminder.continuityGapMs,
      i18n,
    });
    db = openDatabase(path, { busyTimeoutMs: identity.busyTimeoutMs });
    const store = new SqliteMemoryStore(db);
    const registry = registryFor(store);
    // Registration no longer creates an agent; POST /session resolves one per character.
    const a = registry.register();
    const b = registry.register();
    check(a.ok && b.ok, 'probe_registration_failed');
    const first = registry.resolve(a.deviceToken, 'xiaonuan');
    check(first.ok && first.ctx.ownerId && first.ctx.agentId, 'probe_owner_missing');
    const { ownerId, agentId } = first.ctx;
    const sessionId = randomUUID();
    registry.lifecycle.started(sessionId, first.ctx);
    const writer = new SqliteTranscriptWriter(store, i18n.safety);
    const user = [
      '叫我老张就行，我老家山东的。',
      '退休前是中学老师，爱喝茉莉花茶。',
      '我膝盖不好，上下楼有点费劲。',
    ];
    const append = (role, text) => writer.append({ ownerId, agentId, sessionId, role, text, now: Date.now() });
    check(append('user', user[0]).result === 'skipped', 'probe_notice_gate_failed');
    writer.markNotified(ownerId, Date.now());
    for (const line of user) check(append('user', line).result === 'stored', 'probe_user_write_failed');
    check(append('assistant', '好，老张，我记住了。').result === 'stored', 'probe_assistant_write_failed');
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
      systemPrompts: { zh: roles.extractPrompt('zh') },
      maxTokens: memory.extractMaxTokens,
      policy: memory.extractPolicy,
      transcriptMaxChars: memory.extractTranscriptMaxChars,
      contextMaxChars: memory.extractContextMaxChars,
    });
    await worker.enqueue(ownerId, agentId, 'session_end', 'zh');
    registry.lifecycle.ended(sessionId, first.ctx);
    const messages = db.prepare('SELECT count(*) AS total, sum(extracted) AS extracted FROM messages WHERE owner_id = ?').get(ownerId);
    stats.messages = messages.total;
    stats.extracted = messages.extracted;
    const profile = store.listProfileFacts(ownerId);
    const facts = store.listAgentFacts(ownerId, agentId);
    stats.addressingFacts = profile.filter(fact => fact.category === 'addressing').length;
    stats.addressingNameMatches = profile.filter(fact => fact.category === 'addressing' && fact.text.includes('老张')).length;
    stats.profileFacts = profile.filter(fact => fact.category === 'profile').length;
    stats.nameMatches = [...profile, ...facts].filter(fact => fact.text.includes('老张')).length;
    stats.preferenceMatches = facts.filter(fact => fact.category === 'preference' && fact.text.includes('茉莉花茶')).length;
    stats.healthFacts = facts.filter(fact => fact.category === 'health' && fact.sensitive).length;
    check(messages.total === 4 && messages.extracted === 4, 'probe_extraction_not_applied');
    check(store.listPendingMessages(ownerId, agentId).length === 0, 'probe_tail_not_extracted');
    check(profile.some(fact => fact.category === 'addressing' && fact.text.includes('老张')), 'probe_addressing_missing');
    check(profile.some(fact => fact.category === 'profile' && (fact.text.includes('山东') || fact.text.includes('老师'))), 'probe_profile_missing');
    check(facts.some(fact => fact.category === 'preference' && fact.text.includes('茉莉花茶')), 'probe_preference_missing');
    check(facts.some(fact => fact.category === 'health' && fact.sensitive), 'probe_health_sensitive_missing');
    // Q36 source ids, read straight from both fact tables.
    const sourceRows = [
      ...db.prepare('SELECT source_message_ids AS s FROM profile_facts WHERE owner_id = ?').all(ownerId),
      ...db.prepare('SELECT source_message_ids AS s FROM agent_facts WHERE owner_id = ?').all(ownerId),
    ];
    const sources = sourceRate(sourceRows.map(row => ({ sources: JSON.parse(row.s) })));
    const categories = db.prepare('SELECT category, COUNT(*) AS n FROM agent_facts WHERE owner_id = ? GROUP BY category').all(ownerId);
    const shared = db.prepare('SELECT category, COUNT(*) AS n FROM profile_facts WHERE owner_id = ? GROUP BY category').all(ownerId);
    check(sources.rate >= 0.9, 'probe_sources_below_floor');
    db.close();
    db = openDatabase(path, { busyTimeoutMs: identity.busyTimeoutMs });
    const reopened = registryFor(new SqliteMemoryStore(db));
    const again = reopened.resolve(a.deviceToken, 'xiaonuan');
    const other = reopened.resolve(b.deviceToken, 'xiaonuan');
    check(again.ok && again.ctx.memorySnapshot?.includes('老张') && again.ctx.memorySnapshot.includes('茉莉花茶'), 'probe_snapshot_missing');
    // The full view may quote the user's own recent statement (roadmap contract); sensitive facts
    // stay out of the greeting and proactive views.
    check(!(again.ctx.greetingMemorySnapshot ?? '').includes('膝盖'), 'probe_sensitive_in_greeting');
    check(!(again.ctx.proactiveMemorySnapshot ?? '').includes('膝盖'), 'probe_sensitive_in_proactive');
    check(other.ok && !other.ctx.memorySnapshot, 'probe_owner_isolation_failed');
    const instructions = buildInstructions({
      persona: roles.buildPersona('xiaonuan', 'zh'),
      memorySnapshot: again.ctx.memorySnapshot,
      summary: '',
      recent: [],
    }, undefined, PROMPT_LABELS.zh);
    check(instructions.includes(PROMPT_LABELS.zh.memoryHeader) && instructions.includes('老张'), 'probe_instructions_missing');
    console.log(JSON.stringify({ probe: 'sources', ...sources }));
    console.log(JSON.stringify({ probe: 'categories', agent: categories, shared }));
    console.log(JSON.stringify({ event: 'qwen_memory_probe', ok: true, ...stats, sources: sources.rate, persistedSnapshot: true, ownerIsolated: true, ms: Math.round(performance.now() - started) }));
  } catch (error) {
    console.log(JSON.stringify({ event: 'qwen_memory_probe', ok: false, code: errorCodeOf(error), ...stats, ms: Math.round(performance.now() - started) }));
    process.exitCode = 1;
  } finally {
    if (db?.isOpen) db.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
