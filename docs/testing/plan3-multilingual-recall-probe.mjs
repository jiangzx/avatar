// Multilingual recall probe for M2 (ja/en packs + kana bigrams + language evidence rules).
//
// Run with plain node from the repo root:
//   node docs/testing/plan3-multilingual-recall-probe.mjs --temp
//   node docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$HOME/.avatar/memory.db"
//
// The script re-executes itself once with --experimental-transform-types because the
// production modules still use TypeScript parameter properties, which Node's strip-only
// mode cannot load. No network, no model calls, no API key, no tsx loader.
//
// --temp builds a synthetic in-memory database, drives the production
// createToolRegistry()/recall_memory path, and asserts the multilingual recall contract.
// Synthetic text may be printed only in this mode.
//
// --real-db opens the given SQLite file read-only (no migrations, no PRAGMA journal_mode,
// no writes), picks the first owner that has messages, and runs the three roadmap queries
// through the zh production recall path with no text client (verbatim fallback only).
// It prints exactly one JSON object per query and never prints stored or spoken text:
//   query          roadmap query that was run
//   hits           true when the outcome is a grounded memory hit (spokenFound)
//   evidenceCount  number of candidate lines that passed the evidence filter
//   newTitleFlag   true only when the spoken text quotes a title marker absent from the
//                  source lines (detects a phrasing model inventing a work title)
// If the database is missing, unreadable, lacks a migration the current store prepares
// against, or the read-only WAL open fails, it prints "NOT RUN <short_reason_code>" once
// and exits 0 (codes: db_path_missing, db_missing, db_open_failed, db_unreadable,
// db_schema_incompatible, db_no_owner). NOT RUN is not a pass.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const TRANSFORM_FLAG = '--experimental-transform-types';
const REEXEC_MARKER = 'AVATAR_MULTILINGUAL_PROBE_REEXEC';

if (!process.execArgv.includes(TRANSFORM_FLAG) && process.env[REEXEC_MARKER] !== '1') {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', TRANSFORM_FLAG, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, [REEXEC_MARKER]: '1' } },
  );
  process.exit(result.status ?? 1);
}

const { loadI18n } = await import('../../gateway/src/i18n/load.ts');
const { bigrams } = await import('../../gateway/src/memory/bigram.ts');
const { isMemoryEvidence } = await import('../../gateway/src/memory/evidence.ts');
const { openDatabase } = await import('../../gateway/src/memory/db.ts');
const { SqliteMemoryStore } = await import('../../gateway/src/memory/store.ts');
const { ActionRouter } = await import('../../gateway/src/session/actions.ts');
const { ConversationLedger } = await import('../../gateway/src/session/ledger.ts');
const { createToolRegistry } = await import('../../gateway/src/session/tools/registry.ts');

const i18n = loadI18n(fileURLToPath(new URL('../../gateway/config', import.meta.url)));
const ROADMAP_QUERIES = ['上次聊到哪儿了', '上次聊过电影吗', '我说过喜欢喝茶吗'];

function registryFor(language) {
  return createToolRegistry({
    language,
    memory: i18n.memory[language],
    evidence: i18n.evidence,
    recentQueries: i18n.recentQueries,
    // Unused without a text client; the probe never calls a model.
    recallPrompt: 'probe: no phrasing model',
    safety: i18n.safety,
    clipChars: 80,
    phraseTimeoutMs: 1_500,
  });
}

function toolContext(store, ownerId, extra = {}) {
  return {
    ownerId,
    sessionId: 'probe-session',
    store,
    ledger: new ConversationLedger(),
    actions: new ActionRouter(),
    now: 1,
    ...extra,
  };
}

/** History lines that survived the evidence filter, without the wrap text. */
function historyLines(outcome, language) {
  const wrap = i18n.memory[language].recall.wrapText;
  if (typeof outcome.text !== 'string' || !outcome.text.startsWith(`${wrap}\n`)) return [];
  return outcome.text.slice(wrap.length + 1).split('\n').filter(Boolean);
}

/** Same title gate as grounded(): a quoted title absent from the source is a new fact. */
function newTitleFlag(spokenText, sourceLines) {
  const source = sourceLines.join('\n');
  for (const match of spokenText.matchAll(/[《「『“"]([^》」』”"]{1,20})[》」』”"]/g)) {
    if (!source.includes(match[1])) return true;
  }
  return false;
}

function insert(store, ownerId, sessionId, id, role, text, now) {
  store.insertMessage({ id, sessionId, ownerId, role, text, bigrams: bigrams(text), now });
}

async function runTemp() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1_000 });
  let checks = 0;
  const check = (value, code) => {
    assert.ok(value, code);
    checks += 1;
  };
  try {
    const store = new SqliteMemoryStore(db);
    const { ownerId, agentId } = store.createOwner({
      tokenHash: 'probe-temp', roleId: 'elder-companion', styleId: 'grandchild', now: 1,
    });

    // Ended session: the only statement the vague-recall path may surface is the newest one.
    store.recordSessionStart('probe-ended', agentId, 2);
    insert(store, ownerId, 'probe-ended', 'zh-newest', 'user', '我最近在看老电影。', 2_000);
    insert(store, ownerId, 'probe-ended', 'zh-question', 'user', '我说过喜欢喝茶吗？', 2_100);
    insert(store, ownerId, 'probe-ended', 'zh-assistant', 'assistant', '嗯，您最近在看老电影。', 2_200);
    store.recordSessionEnd('probe-ended', agentId, 2_300);

    // Active session: FTS still sees these, but vague recall (recent user messages) must not.
    store.recordSessionStart('probe-active', agentId, 2_400);
    insert(store, ownerId, 'probe-active', 'ja-yoga', 'user', '私は毎朝ヨガをしています。', 2_500);
    insert(store, ownerId, 'probe-active', 'ja-question', 'user', 'お茶が好きだと言いましたか', 2_600);
    insert(store, ownerId, 'probe-active', 'en-movies', 'user', 'I like watching old movies.', 2_700);
    insert(store, ownerId, 'probe-active', 'en-question', 'user', 'Did I say I like tea?', 2_800);
    insert(store, ownerId, 'probe-active', 'zh-active', 'user', '这是还没结束的会话里的句子。', 2_900);

    const ja = registryFor('ja');
    const zh = registryFor('zh');
    const en = registryFor('en');
    const ctx = () => toolContext(store, ownerId);

    // ja: kana-only statement is recallable by a katakana query.
    const yoga = await ja.handle('recall_memory', { query: 'ヨガ' }, ctx());
    check(yoga.ok === true && yoga.spokenFound === true, 'ja_yoga_not_found');
    check(historyLines(yoga, 'ja')[0] === '私は毎朝ヨガをしています。', 'ja_yoga_line');
    check(yoga.text.startsWith(i18n.memory.ja.recall.wrapText), 'ja_wrap_copy');
    check(yoga.spokenText.includes('ヨガ'), 'ja_spoken_grounded');

    // zh: vague recall uses recent ended-session statements only, newest first.
    const vague = await zh.handle('recall_memory', { query: '上次聊到哪儿了' }, ctx());
    check(vague.spokenFound === true, 'zh_vague_not_found');
    check(JSON.stringify(historyLines(vague, 'zh')) === JSON.stringify(['我最近在看老电影。']), 'zh_vague_recent_only');
    check(!vague.text.includes('这是还没结束的会话里的句子。'), 'zh_vague_active_session');
    check(vague.spokenText === `${i18n.memory.zh.recall.foundPrefix}我最近在看老电影。`, 'zh_vague_verbatim');

    // zh: the stored question is not evidence, so asking again finds nothing.
    const zhQuestion = await zh.handle('recall_memory', { query: '我说过喜欢喝茶吗' }, ctx());
    check(zhQuestion.spokenFound === false, 'zh_question_as_evidence');
    check(historyLines(zhQuestion, 'zh').length === 0, 'zh_question_lines');

    // ja: a recall question is not evidence. Shared kana tokens may still surface another
    // evidence line, so assert the question itself never becomes the quoted history.
    check(isMemoryEvidence('お茶が好きだと言いましたか', i18n.evidence) === false, 'ja_question_rule');
    const jaQuestion = await ja.handle('recall_memory', { query: 'お茶が好きだと言いましたか' }, ctx());
    check(!historyLines(jaQuestion, 'ja').includes('お茶が好きだと言いましたか'), 'ja_question_as_evidence');

    // en: a denial/question is not evidence; a statement is recallable by a Latin token.
    check(isMemoryEvidence('Did I say I like tea?', i18n.evidence) === false, 'en_question_rule');
    const enQuestion = await en.handle('recall_memory', { query: 'Did I say I like tea' }, ctx());
    check(!historyLines(enQuestion, 'en').includes('Did I say I like tea?'), 'en_question_as_evidence');
    const movies = await en.handle('recall_memory', { query: 'movies' }, ctx());
    check(movies.spokenFound === true, 'en_movies_not_found');
    check(historyLines(movies, 'en')[0] === 'I like watching old movies.', 'en_movies_line');

    // sameUtterance: the current turn never becomes its own memory hit.
    const selfHit = await zh.handle('recall_memory', { query: '老电影' }, ctx());
    check(selfHit.spokenFound === true, 'zh_movie_control');
    const dropped = await zh.handle(
      'recall_memory',
      { query: '老电影' },
      toolContext(store, ownerId, { triggerText: '我最近在看老电影。' }),
    );
    check(dropped.spokenFound === false && historyLines(dropped, 'zh').length === 0, 'same_utterance_dropped');

    // Phrasing with a new work title is rejected and falls back to the verbatim line.
    let phrased = 0;
    const inventing = registryFor('zh');
    const titled = await inventing.handle('recall_memory', { query: '老电影' }, toolContext(store, ownerId, {
      textClient: {
        complete: async () => {
          phrased += 1;
          return JSON.stringify({ text: '您最近在看《庐山恋》。' });
        },
      },
    }));
    check(phrased === 1, 'title_client_called');
    check(titled.spokenFound === true, 'title_control');
    check(titled.spokenText === `${i18n.memory.zh.recall.foundPrefix}我最近在看老电影。`, 'title_verbatim_fallback');
    check(!titled.spokenText.includes('《') && !titled.spokenText.includes('庐山恋'), 'title_not_spoken');

    console.log(JSON.stringify({ mode: 'temp', checks, ok: true }));
  } finally {
    if (db.isOpen) db.close();
  }
}

function notRun(reason) {
  console.log(`NOT RUN ${reason}`);
  process.exitCode = 0;
}

async function runRealDb(path) {
  if (!path) return notRun('db_path_missing');
  if (!existsSync(path)) return notRun('db_missing');

  let db;
  try {
    // Read-only: no openDatabase, no migrations, no PRAGMA journal_mode.
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return notRun('db_open_failed');
  }

  try {
    let ownerId;
    try {
      const row = db.prepare('SELECT owner_id FROM messages ORDER BY rowid LIMIT 1').get();
      ownerId = row?.owner_id;
    } catch {
      return notRun('db_unreadable');
    }
    if (!ownerId) return notRun('db_no_owner');

    let store;
    try {
      store = new SqliteMemoryStore(db); // constructor only prepares statements
    } catch {
      // The current store prepares against tables added by later migrations; the probe
      // must not migrate or write, so an older schema is a NOT RUN, not a failure.
      return notRun('db_schema_incompatible');
    }

    await runQueries(registryFor('zh'), store, ownerId);
  } finally {
    if (db.isOpen) db.close();
  }
}

async function runQueries(zh, store, ownerId) {
  for (const query of ROADMAP_QUERIES) {
    const outcome = await zh.handle('recall_memory', { query }, toolContext(store, ownerId));
    const lines = historyLines(outcome, 'zh');
    console.log(JSON.stringify({
      query,
      hits: outcome.spokenFound === true,
      evidenceCount: lines.length,
      newTitleFlag: newTitleFlag(outcome.spokenText ?? '', lines),
    }));
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--temp' && args.length === 1) {
    runTemp().catch(error => {
      console.error(`PROBE FAILED ${error?.message ?? error}`);
      process.exitCode = 1;
    });
    return;
  }
  if (args[0] === '--real-db') {
    runRealDb(args[1]).catch(error => {
      console.error(`PROBE FAILED ${error?.message ?? error}`);
      process.exitCode = 1;
    });
    return;
  }
  console.error('usage: node docs/testing/plan3-multilingual-recall-probe.mjs --temp | --real-db <path>');
  process.exitCode = 2;
}

main();
