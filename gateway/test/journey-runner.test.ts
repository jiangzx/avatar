import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockAdapter, loadMockScript, withCharacterName } from '../src/adapters/mock.ts';
import { loadEvalConfig } from '../src/eval/harness.ts';
import { parseJourneys, runJourney, sessionStartAt, type JourneyEnv } from '../src/eval/journey.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';
import { MockSummarizer } from '../src/session/ledger.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6_000 };
const snapshot = buildConfigSnapshot({
  gatewayRoot: root,
  overlay: {},
  version: 0,
  ledger,
  sessionStartTimeoutMs: 10_000,
  models: { realtimeEndpoint: '', realtimeModel: 'mock', textEndpoint: '', summarizerModel: 'mock' },
});
const script = loadMockScript(`${root}mock/script.json`);
const base = loadEvalConfig(`${root}config/eval.json`);
// Fast playback for tests: the runner logic is under test, not pacing.
const cfg = { ...base, run: { ...base.run, playbackSpeed: 8, settleMs: 300, replyTimeoutMs: 5_000, progressEveryMs: 100 } };

const env: JourneyEnv = {
  snapshot,
  factories: {
    apiKey: () => undefined,
    adapter: ({ snapshot: s, characterId }) => new MockAdapter({
      script: withCharacterName(script, s.characters.name(characterId, 'zh')),
      replyDelayMs: 30, charMs: 10, chunkMs: 100, paceFactor: 1,
    }),
    summarizer: () => new MockSummarizer(),
    textClient: () => undefined,
    voiceFor: () => undefined,
  },
  runtime: { ledger, modelOwnsTurns: false },
};

const [journey] = parseJourneys([{
  id: 'two-days',
  title: '两天两次',
  character: 'xiaonuan',
  start: '2026-11-02',
  sessions: [
    { day: 0, time: '09:00', turns: ['你好'] },
    { day: 1, time: '20:15', turns: ['我又来了'] },
    { day: 1, time: '21:00', character: 'xiaokai', turns: ['你好'] },
  ],
}]);

describe('runJourney', () => {
  it('chains sessions on one owner with the simulated clock', async () => {
    const run = await runJourney(env, journey!, cfg);
    expect(run.journeyId).toBe('two-days');
    expect(run.sessions.map((s) => [s.index, s.day, s.time, s.character])).toEqual([
      [0, 0, '09:00', 'xiaonuan'],
      [1, 1, '20:15', 'xiaonuan'],
      [2, 1, '21:00', 'xiaokai'],
    ]);
    // The second meeting with the same character is not a first meet; a new character is.
    expect(run.sessions.map((s) => s.firstMeet)).toEqual([true, false, true]);
    run.sessions.forEach((s, i) => {
      expect(s.startedAt).toBe(sessionStartAt(journey!, journey!.sessions[i]!));
      // Every session opens with a greeting (turn 0), and the user turn gets a reply.
      expect(s.replies.some((r) => r.turn === 0)).toBe(true);
      expect(s.replies.some((r) => r.turn === 1 && r.text.length > 0)).toBe(true);
    });
  }, 60_000);
});
