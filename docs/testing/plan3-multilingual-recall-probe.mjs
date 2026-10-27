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
// Time words in a vague query only select the recent-statement path; no date filtering is done.
// Synthetic text may be printed only in this mode.
//
// --real-db opens the given SQLite file read-only (no migrations, no PRAGMA journal_mode,
// no writes), picks the first owner that has messages, and runs the three roadmap zh queries
// plus read-only ja/en diagnostics through each language's production recall path with no
// text client (verbatim fallback only). The ja/en rows are diagnostics, not assertions: a
// zh-only database may legitimately return no hits.
// A pre-M2 database has no `meta` table, which the current SqliteMemoryStore prepares
// against; in that case the probe uses a read-only fallback store with the same SELECTs.
// It prints exactly one JSON object per query and never prints stored or spoken text:
//   language       registry language used for the query
//   query          query that was run
//   hits           the grounded-hit boolean (the tool's spokenFound)
//   evidenceCount  number of grounded history lines the tool returned (candidate lines
//                  that passed the evidence filter)
//   newTitleFlag   true only when the spoken text quotes a title marker absent from the
//                  source lines (detects a phrasing model inventing a work title).
//                  Structurally false in --real-db because no text client is passed; it is
//                  exercised in --temp with the fake phrasing client and kept here for
//                  field compatibility.
// If the database is missing, unreadable, lacks the tables recall needs, or the read-only
// WAL open fails, it prints "NOT RUN <short_reason_code>" once and exits 0 (codes:
// db_path_missing, db_missing, db_open_failed, db_unreadable, db_schema_incompatible,
// db_no_owner). NOT RUN is not a pass.

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
const REAL_DB_QUERIES = [
  { language: 'zh', query: '上次聊到哪儿了' },
  { language: 'zh', query: '上次聊过电影吗' },
  { language: 'zh', query: '我说过喜欢喝茶吗' },
  // Read-only cross-language diagnostics; no hit is asserted for these.
  { language: 'en', query: 'What did we talk about?' },
  { language: 'ja', query: '前に何を話した' },
  { language: 'en', query: 'tea' },
  { language: 'ja', query: 'お茶' },
];

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
    characterId: 'xiaonuan',
    sessionId: 'probe-session',
    store,
    ledger: new ConversationLedger(),
    actions: new ActionRouter(),
    now: 1,
    turn: { currentFinal: async () => null, previousFinal: () => null },
    memoryGate: () => 'ok',
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

/**
 * Read-only fallback for pre-M2 databases: the current SqliteMemoryStore prepares
 * statements against the `meta` table (kana backfill cursor), which older files lack.
 * These are the same SELECTs the store uses for recall; nothing is migrated or written.
 */
function readOnlyStore(db) {
  const recent = db.prepare(`SELECT m.text AS text FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.owner_id = ? AND m.role = 'user' AND m.excluded = 0 AND s.ended_at IS NOT NULL
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT ?`);
  const search = db.prepare(`SELECT m.text AS text FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ? AND m.owner_id = ? AND m.role = 'user' AND m.excluded = 0
    ORDER BY bm25(messages_fts)
    LIMIT ?`);
  const searchLike = db.prepare(`SELECT text FROM messages
    WHERE owner_id = ? AND role = 'user' AND excluded = 0 AND text LIKE ? ESCAPE '\\'
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?`);
  const texts = (statement, ...args) => statement.all(...args).map((row) => ({ text: row.text }));
  return {
    recentUserMessages: (ownerId, limit) => texts(recent, ownerId, limit),
    searchMessages: (ownerId, match, limit) => {
      try {
        return texts(search, match, ownerId, limit);
      } catch {
        return [];
      }
    },
    searchMessagesLike: (ownerId, pattern, limit) => texts(searchLike, ownerId, pattern, limit),
  };
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

    // Separate owner: a said-frame query must not match statements sharing only the frame words.
    const frame = store.createOwner({
      tokenHash: 'probe-frame', roleId: 'elder-companion', styleId: 'grandchild', now: 3,
    });
    store.recordSessionStart('probe-frame-session', frame.agentId, 3_001);
    insert(store, frame.ownerId, 'probe-frame-session', 'zh-frame-unrelated', 'user', '我说今天有点累。', 3_100);
    insert(store, frame.ownerId, 'probe-frame-session', 'ja-frame-unrelated', 'user', '私は昨日映画を見ました。', 3_200);
    insert(store, frame.ownerId, 'probe-frame-session', 'en-frame-unrelated', 'user', 'I said I was tired.', 3_300);
    // Denials and whole-utterance light acks must never become grounded history.
    insert(store, frame.ownerId, 'probe-frame-session', 'zh-denial', 'user', '我没说过喜欢喝茶。', 3_350);
    insert(store, frame.ownerId, 'probe-frame-session', 'ja-denial', 'user', 'お茶が好きなんて言ってない。', 3_360);
    insert(store, frame.ownerId, 'probe-frame-session', 'en-denial', 'user', "I didn't say I like tea.", 3_370);
    insert(store, frame.ownerId, 'probe-frame-session', 'zh-ack', 'user', '好的', 3_380);
    insert(store, frame.ownerId, 'probe-frame-session', 'ja-ack', 'user', 'はい', 3_390);
    insert(store, frame.ownerId, 'probe-frame-session', 'en-ack', 'user', 'Okay', 3_400);
    const frameCtx = () => toolContext(store, frame.ownerId);

    // Separate owner: en vague recall must use ended-session statements only.
    const vagueOwner = store.createOwner({
      tokenHash: 'probe-vague', roleId: 'elder-companion', styleId: 'grandchild', now: 4,
    });
    store.recordSessionStart('probe-vague-session', vagueOwner.agentId, 4_001);
    insert(store, vagueOwner.ownerId, 'probe-vague-session', 'en-vague-recent', 'user', 'I like watching old movies.', 4_100);
    insert(store, vagueOwner.ownerId, 'probe-vague-session', 'en-vague-park', 'user', 'I went to the park yesterday.', 4_150);
    store.recordSessionEnd('probe-vague-session', vagueOwner.agentId, 4_200);
    store.recordSessionStart('probe-vague-active', vagueOwner.agentId, 4_300);
    insert(store, vagueOwner.ownerId, 'probe-vague-active', 'en-vague-active', 'user', 'This is still the active session.', 4_400);
    const vagueCtx = () => toolContext(store, vagueOwner.ownerId);

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

    // Said-frames: unrelated statements sharing only the frame words are not recalled.
    const zhFrame = '我说过喜欢喝茶吗';
    const zhPrefixed = '你还记得我说过喜欢喝茶吗';
    const zhFillers = ['那个，我说过喜欢喝茶吗', '我记得我说过喜欢喝茶吗', '我想问一下我说过喜欢喝茶吗'];
    const zhMoviePrefix = '我还记得我说过的电影吗';
    const jaFrame = 'お茶が好きだと言いましたか';
    const enFrame = 'Did I say I like tea?';
    const enIndirect = 'Have I told you that I like tea?';
    check((await zh.handle('recall_memory', { query: zhFrame }, frameCtx())).spokenFound === false, 'zh_frame_unrelated');
    check((await zh.handle('recall_memory', { query: zhPrefixed }, frameCtx())).spokenFound === false, 'zh_prefix_unrelated');
    for (const query of zhFillers) {
      check((await zh.handle('recall_memory', { query }, frameCtx())).spokenFound === false, 'zh_filler_unrelated');
    }
    check((await zh.handle('recall_memory', { query: zhMoviePrefix }, frameCtx())).spokenFound === false, 'zh_movie_prefix_unrelated');
    check((await ja.handle('recall_memory', { query: jaFrame }, frameCtx())).spokenFound === false, 'ja_frame_unrelated');
    check((await en.handle('recall_memory', { query: enFrame }, frameCtx())).spokenFound === false, 'en_frame_unrelated');
    check((await en.handle('recall_memory', { query: enIndirect }, frameCtx())).spokenFound === false, 'en_indirect_unrelated');

    // Denials and whole-utterance light acks are never evidence, so they never become history.
    const evidenceRows = [
      { language: 'zh', text: '我没说过喜欢喝茶。', ack: '好的', query: '喝茶' },
      { language: 'ja', text: 'お茶が好きなんて言ってない。', ack: 'はい', query: 'お茶' },
      { language: 'en', text: "I didn't say I like tea.", ack: 'Okay', query: 'tea' },
    ];
    const registries = { zh, ja, en };
    for (const row of evidenceRows) {
      check(isMemoryEvidence(row.text, i18n.evidence) === false, `${row.language}_denial_rule`);
      check(isMemoryEvidence(row.ack, i18n.evidence) === false, `${row.language}_ack_rule`);
      const result = await registries[row.language].handle('recall_memory', { query: row.query }, frameCtx());
      check(!historyLines(result, row.language).includes(row.text), `${row.language}_denial_not_recalled`);
      check(!historyLines(result, row.language).includes(row.ack), `${row.language}_ack_not_recalled`);
      const ackHit = await registries[row.language].handle('recall_memory', { query: row.ack }, frameCtx());
      check(ackHit.spokenFound === false, `${row.language}_ack_not_grounded`);
    }

    insert(store, frame.ownerId, 'probe-frame-session', 'zh-frame-content', 'user', '我喜欢喝茶。', 3_450);
    insert(store, frame.ownerId, 'probe-frame-session', 'zh-movie-content', 'user', '我最近在看老电影。', 3_455);
    insert(store, frame.ownerId, 'probe-frame-session', 'ja-frame-content', 'user', '私はお茶が好きです。', 3_460);
    insert(store, frame.ownerId, 'probe-frame-session', 'en-frame-content', 'user', 'I like tea.', 3_470);
    const zhFrameHit = await zh.handle('recall_memory', { query: zhFrame }, frameCtx());
    check(zhFrameHit.spokenFound === true, 'zh_frame_content');
    check(historyLines(zhFrameHit, 'zh').includes('我喜欢喝茶。'), 'zh_frame_content_line');
    check(!historyLines(zhFrameHit, 'zh').includes('我说今天有点累。'), 'zh_frame_unrelated_line');
    const zhPrefixedHit = await zh.handle('recall_memory', { query: zhPrefixed }, frameCtx());
    check(zhPrefixedHit.spokenFound === true, 'zh_prefix_content');
    check(historyLines(zhPrefixedHit, 'zh').includes('我喜欢喝茶。'), 'zh_prefix_content_line');
    check(!historyLines(zhPrefixedHit, 'zh').includes('我说今天有点累。'), 'zh_prefix_unrelated_line');
    for (const query of zhFillers) {
      const hit = await zh.handle('recall_memory', { query }, frameCtx());
      check(hit.spokenFound === true, 'zh_filler_content');
      check(historyLines(hit, 'zh').includes('我喜欢喝茶。'), 'zh_filler_content_line');
      check(!historyLines(hit, 'zh').includes('我说今天有点累。'), 'zh_filler_unrelated_line');
    }
    const zhMoviePrefixHit = await zh.handle('recall_memory', { query: zhMoviePrefix }, frameCtx());
    check(zhMoviePrefixHit.spokenFound === true, 'zh_movie_prefix_content');
    check(historyLines(zhMoviePrefixHit, 'zh').includes('我最近在看老电影。'), 'zh_movie_prefix_content_line');
    check(!historyLines(zhMoviePrefixHit, 'zh').includes('我说今天有点累。'), 'zh_movie_prefix_unrelated_line');
    const jaFrameHit = await ja.handle('recall_memory', { query: jaFrame }, frameCtx());
    check(jaFrameHit.spokenFound === true, 'ja_frame_content');
    check(historyLines(jaFrameHit, 'ja').includes('私はお茶が好きです。'), 'ja_frame_content_line');
    check(!historyLines(jaFrameHit, 'ja').includes('私は昨日映画を見ました。'), 'ja_frame_unrelated_line');
    const enFrameHit = await en.handle('recall_memory', { query: enFrame }, frameCtx());
    check(enFrameHit.spokenFound === true, 'en_frame_content');
    check(historyLines(enFrameHit, 'en').includes('I like tea.'), 'en_frame_content_line');
    check(!historyLines(enFrameHit, 'en').includes('I said I was tired.'), 'en_frame_unrelated_line');
    const enIndirectHit = await en.handle('recall_memory', { query: enIndirect }, frameCtx());
    check(enIndirectHit.spokenFound === true, 'en_indirect_content');
    check(historyLines(enIndirectHit, 'en').includes('I like tea.'), 'en_indirect_content_line');
    check(!historyLines(enIndirectHit, 'en').includes('I said I was tired.'), 'en_indirect_unrelated_line');

    // en vague recall: ended-session statements only.
    const vagueEn = await en.handle('recall_memory', { query: 'What did we talk about?' }, vagueCtx());
    check(vagueEn.spokenFound === true, 'en_vague_found');
    check(historyLines(vagueEn, 'en').includes('I like watching old movies.'), 'en_vague_recent_line');
    check(!historyLines(vagueEn, 'en').includes('This is still the active session.'), 'en_vague_active_excluded');

    // Specific en questions must use FTS, not the vague recent-statement path.
    for (const query of [
      'Do you remember what movies we watched?',
      'Did we talk about movies?',
      'What did we say about movies?',
    ]) {
      const hit = await en.handle('recall_memory', { query }, vagueCtx());
      check(hit.spokenFound === true, 'en_specific_found');
      check(historyLines(hit, 'en').includes('I like watching old movies.'), 'en_specific_movie');
      check(!historyLines(hit, 'en').includes('I went to the park yesterday.'), 'en_specific_park_excluded');
    }
    const discussed = await en.handle('recall_memory', { query: 'What did we discuss about movies?' }, vagueCtx());
    check(discussed.spokenFound === true, 'en_discussed_specific_found');
    check(historyLines(discussed, 'en').includes('I like watching old movies.'), 'en_discussed_specific_movie');
    check(!historyLines(discussed, 'en').includes('I went to the park yesterday.'), 'en_discussed_specific_park_excluded');
    for (const query of [
      'And what did we talk about?',
      'Okay, what did we talk about?',
      'What did we talk about today?',
      'What did we talk about earlier?',
      'What did we talk about this morning?',
      'What did we talk about last night?',
      'What did we talk about last week?',
      'What did we talk about this afternoon?',
      'What did we talk about in the morning?',
      'What did we say just now?',
      'What did we talk about? ❤️',
      'You know, what did we talk about?',
      'Do you remember our last conversation?',
      'Last conversation?',
    ]) {
      const vague = await en.handle('recall_memory', { query }, vagueCtx());
      check(vague.spokenFound === true, 'en_filler_vague_found');
      check(historyLines(vague, 'en')[0] === 'I went to the park yesterday.', 'en_filler_vague_newest');
    }
    for (const query of [
      'Do you remember?', 'What did we say?', 'What did we talk about?',
      'What did we say,', 'What did we say?"', 'Do you remember，',
    ]) {
      const bare = await en.handle('recall_memory', { query }, vagueCtx());
      check(bare.spokenFound === true, 'en_bare_vague_found');
      check(historyLines(bare, 'en')[0] === 'I went to the park yesterday.', 'en_bare_vague_newest');
    }

    // en phrasing: whole-word tokens are enough for the grounded gate.
    const phrasedEn = await en.handle('recall_memory', { query: 'movies' }, toolContext(store, ownerId, {
      textClient: { complete: async () => JSON.stringify({ text: 'You like watching old movies a lot.' }) },
    }));
    check(phrasedEn.spokenFound === true, 'en_phrase_control');
    check(phrasedEn.spokenText === 'You like watching old movies a lot.', 'en_phrase_applied');

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
      // Pre-M2 schema (no `meta` table): use the read-only SELECT fallback. Never migrate.
      try {
        store = readOnlyStore(db);
      } catch {
        return notRun('db_schema_incompatible');
      }
    }

    await runQueries(store, ownerId);
  } finally {
    if (db.isOpen) db.close();
  }
}

async function runQueries(store, ownerId) {
  for (const { language, query } of REAL_DB_QUERIES) {
    const outcome = await registryFor(language).handle('recall_memory', { query }, toolContext(store, ownerId));
    const lines = historyLines(outcome, language);
    console.log(JSON.stringify({
      language,
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
