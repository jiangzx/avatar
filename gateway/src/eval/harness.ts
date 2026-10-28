import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AI_SAMPLE_RATE, type ResponseKind, type ServerMessage } from '@anyidea/protocol';
import type { ReplyMetrics } from '../session/metrics.ts';
import type { Session, Transport } from '../session/session.ts';
import { summarizeScores, type JudgeInput, type JudgeScores } from './judge.ts';
import { countQuestions, type QuestionRule } from './questions.ts';

const EvalConfigSchema = z.object({
  question: z.object({
    endMarks: z.array(z.string().min(1)).min(1),
    finalParticles: z.array(z.string().length(1)),
    neParticle: z.string().length(1),
    interrogatives: z.array(z.string().min(1)),
    quotePairs: z.array(z.tuple([z.string().length(1), z.string().length(1)])),
  }).strict(),
  gate: z.object({
    maxQuestionRatio: z.number().gt(0).max(1),
    maxAvgReplyChars: z.number().int().min(5).max(500),
    // Plan-a rule: the fixed opening is not part of the conversational question ratio.
    excludeGreetingFromQuestionRatio: z.boolean().optional(),
  }).strict(),
  run: z.object({
    playbackSpeed: z.number().gt(0).max(50),
    settleMs: z.number().int().min(10).max(10_000),
    replyTimeoutMs: z.number().int().min(100).max(120_000),
    progressEveryMs: z.number().int().min(10).max(5_000),
  }).strict(),
  judge: z.object({
    maxTokens: z.number().int().min(50).max(2_000),
    temperature: z.number().min(0).max(1),
    policy: z.object({
      timeoutMs: z.number().int().min(1_000).max(120_000),
      retries: z.number().int().min(0).max(3),
      backoffMs: z.number().int().min(0).max(30_000),
      maxBackoffMs: z.number().int().min(0).max(60_000),
    }).strict().refine((p) => p.maxBackoffMs >= p.backoffMs, { message: 'maxBackoffMs must be >= backoffMs' }),
  }).strict(),
}).strict();
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

export function loadEvalConfig(path: string): EvalConfig {
  return EvalConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const ScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().min(1).max(40),
  turns: z.array(z.string().min(1).max(200)).min(1).max(10),
  mentions: z.array(z.string().min(1)).optional(),
  /** After the last turn, keep collecting proactive replies for this long (silence ladder). */
  silenceAfterMs: z.number().int().min(1_000).max(60_000).optional(),
}).strict();
export type EvalScenario = z.infer<typeof ScenarioSchema>;

export function loadScenarios(path: string): EvalScenario[] {
  return z.array(ScenarioSchema).min(1).parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface ReplyRecord {
  scenarioId: string;
  turn: number;
  kind: ResponseKind;
  text: string;
  chars: number;
  sentences: number;
  questions: number;
  outputTokens: number | null;
  firstAudioMs: number | null;
  mentioned: boolean;
}

export type SessionMaker = (onReplyMetrics: (m: ReplyMetrics) => void) => Session;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** In-process client stand-in: records server messages and audio, lets the harness await messages. */
export class SimTransport implements Transport {
  readonly audioMs = new Map<number, number>();
  readonly firstAudioAt = new Map<number, number>();
  readonly text = new Map<number, string>();
  private readonly log: ServerMessage[] = [];
  private cursor = 0;
  private wake: Array<() => void> = [];

  send(m: ServerMessage): void {
    if (m.type === 'transcript.assistant') this.text.set(m.responseSeq, (this.text.get(m.responseSeq) ?? '') + m.text);
    this.log.push(m);
    for (const w of this.wake.splice(0)) w();
  }

  sendAudio(seq: number, pcm: Int16Array): void {
    if (!this.firstAudioAt.has(seq)) this.firstAudioAt.set(seq, Date.now());
    this.audioMs.set(seq, (this.audioMs.get(seq) ?? 0) + (pcm.length / AI_SAMPLE_RATE) * 1000);
  }

  /** Next unread message matching `pred`, or null after `timeoutMs`. */
  async next(pred: (m: ServerMessage) => boolean, timeoutMs: number): Promise<ServerMessage | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.log.length) {
        const m = this.log[this.cursor++]!;
        if (pred(m)) return m;
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }
}

export interface Played { seq: number; kind: ResponseKind; firstAudioMs: number | null }

async function simulatePlayback(session: Session, seq: number, audioMs: number, run: EvalConfig['run']): Promise<void> {
  const total = audioMs / run.playbackSpeed;
  let played = 0;
  while (played + run.progressEveryMs < total) {
    await sleep(run.progressEveryMs);
    played += run.progressEveryMs;
    session.handleClientMessage({ type: 'playback.progress', responseSeq: seq, playedMs: Math.round(played * run.playbackSpeed) });
  }
  await sleep(total - played);
  session.handleClientMessage({ type: 'playback.stopped', responseSeq: seq, playedMs: Math.round(audioMs), reason: 'ended' });
}

type ResponseStart = Extract<ServerMessage, { type: 'response.start' }>;

/** Plays one started response to its end, like the client would. */
async function playOne(session: Session, t: SimTransport, run: EvalConfig['run'], start: ResponseStart, sentAt: number | null): Promise<Played> {
  const seq = start.responseSeq;
  const end = await t.next((m) => (m.type === 'response.end' || m.type === 'response.cancelled') && m.responseSeq === seq, run.replyTimeoutMs);
  if (end?.type === 'response.end') await simulatePlayback(session, seq, t.audioMs.get(seq) ?? 0, run);
  const first = t.firstAudioAt.get(seq);
  return { seq, kind: start.kind, firstAudioMs: first !== undefined && sentAt !== null ? first - sentAt : null };
}

/** Plays every response of one exchange (a tool continuation may follow within settleMs). */
export async function playResponses(session: Session, t: SimTransport, run: EvalConfig['run'], sentAt: number | null): Promise<Played[]> {
  const out: Played[] = [];
  let wait = run.replyTimeoutMs;
  for (;;) {
    const start = await t.next((m) => m.type === 'response.start', wait);
    if (!start || start.type !== 'response.start') return out;
    out.push(await playOne(session, t, run, start, sentAt));
    wait = run.settleMs;
  }
}

/** The user stays silent: plays every response that starts within windowMs (the Director's proactive lines). */
export async function playSilence(session: Session, t: SimTransport, run: EvalConfig['run'], windowMs: number): Promise<Played[]> {
  const out: Played[] = [];
  const deadline = Date.now() + windowMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return out;
    const start = await t.next((m) => m.type === 'response.start', left);
    if (!start || start.type !== 'response.start') return out;
    out.push(await playOne(session, t, run, start, null));
  }
}

const countChars = (text: string) => text.replace(/[\s\p{P}]/gu, '').length;

export async function runScenario(make: SessionMaker, scenario: EvalScenario, cfg: EvalConfig): Promise<ReplyRecord[]> {
  const metrics = new Map<number, ReplyMetrics>();
  const session = make((m) => metrics.set(m.seq, m));
  const t = new SimTransport();
  const records: ReplyRecord[] = [];
  const collect = (turn: number, played: Played[]) => {
    for (const p of played) {
      const text = t.text.get(p.seq) ?? '';
      const q = countQuestions(text, cfg.question);
      records.push({
        scenarioId: scenario.id, turn, kind: p.kind, text, chars: countChars(text), sentences: q.sentences, questions: q.questions,
        outputTokens: metrics.get(p.seq)?.outputTokens ?? null, firstAudioMs: p.firstAudioMs,
        mentioned: (scenario.mentions ?? []).some((w) => text.includes(w)),
      });
    }
  };
  try {
    await session.start(t);
    collect(0, await playResponses(session, t, cfg.run, null));
    for (let i = 0; i < scenario.turns.length; i++) {
      const sentAt = Date.now();
      session.handleClientMessage({ type: 'debug.userText', text: scenario.turns[i]! });
      collect(i + 1, await playResponses(session, t, cfg.run, sentAt));
    }
    // Silence replies get turn = turns.length + 1; the window starts once the last turn has settled.
    if (scenario.silenceAfterMs !== undefined) collect(scenario.turns.length + 1, await playSilence(session, t, cfg.run, scenario.silenceAfterMs));
  } finally {
    session.end();
  }
  return records;
}

export interface EvalSummary {
  replies: number;
  /** Sentences in the question-ratio basis (greeting excluded when configured). */
  sentences: number;
  /** Questions in the question-ratio basis (greeting excluded when configured). */
  questions: number;
  questionRatio: number;
  questionRatioScope: 'all' | 'excluding-greeting';
  avgChars: number;
  avgOutputTokens: number | null;
  mentions: number;
  pass: { questionRatio: boolean; avgChars: boolean };
  /** Content-free reason the run is invalid regardless of the gate; null when fine. */
  failure: string | null;
}

export function summarize(records: ReplyRecord[], gate: EvalConfig['gate']): EvalSummary {
  const scoped = gate.excludeGreetingFromQuestionRatio === true;
  const ratioRecords = scoped ? records.filter((r) => r.kind !== 'greeting') : records;
  const sentences = ratioRecords.reduce((n, r) => n + r.sentences, 0);
  const questions = ratioRecords.reduce((n, r) => n + r.questions, 0);
  const tokens = records.map((r) => r.outputTokens).filter((v): v is number => v !== null);
  const questionRatio = sentences === 0 ? 0 : questions / sentences;
  // Avg chars still covers every spoken reply, including the opening.
  const avgChars = records.length === 0 ? 0 : records.reduce((n, r) => n + r.chars, 0) / records.length;
  return {
    replies: records.length, sentences, questions, questionRatio,
    questionRatioScope: scoped ? 'excluding-greeting' : 'all', avgChars,
    avgOutputTokens: tokens.length === 0 ? null : tokens.reduce((a, b) => a + b, 0) / tokens.length,
    mentions: records.filter((r) => r.mentioned).length,
    pass: { questionRatio: questionRatio <= gate.maxQuestionRatio, avgChars: avgChars <= gate.maxAvgReplyChars },
    failure: records.length === 0 ? 'no replies' : ratioRecords.length === 0 ? 'no replies outside greeting' : null,
  };
}

/** Spoken order for the judge: greeting (turn 0), then each user turn and its replies, then silence replies. */
export function toJudgeInput(scenario: EvalScenario, records: readonly ReplyRecord[]): JudgeInput {
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];
  const said = (turn: number) => {
    for (const r of records) if (r.turn === turn && r.text.trim()) turns.push({ role: 'assistant', text: r.text });
  };
  said(0);
  scenario.turns.forEach((text, i) => {
    turns.push({ role: 'user', text });
    said(i + 1);
  });
  said(scenario.turns.length + 1);
  return { scenarioId: scenario.id, title: scenario.title, turns };
}

export interface ScenarioOutcome { scenario: EvalScenario; records: readonly ReplyRecord[]; scores: JudgeScores | null }

export interface EvalResultsMeta {
  commit: string;
  dirty: boolean;
  date: string;
  adapter: string;
  character: string;
  scenarioFile: string;
  rubricFile: string | null;
  judgeModel: string | null;
}

export interface EvalResults extends EvalResultsMeta {
  gated: boolean;
  summary:
    | { replies: number; questionRatio: number; questionRatioScope: EvalSummary['questionRatioScope']; avgChars: number; pass: EvalSummary['pass']; failure: string | null }
    | { replies: number; questionRatio: number; failure: string | null };
  judge: {
    scored: number;
    failures: number;
    mean: JudgeScores | null;
    /** Mean of holdEmotion, nameFeeling, proactive. */
    firstThreeMean: number | null;
    noFabricationAllFive: boolean;
  } | null;
  results: Array<{
    id: string;
    title: string;
    silenceAfterMs: number | null;
    scores: JudgeScores | null;
    replies: Array<Pick<ReplyRecord, 'turn' | 'kind' | 'text' | 'chars' | 'sentences' | 'questions' | 'firstAudioMs' | 'mentioned'>>;
  }>;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Results JSON for docs/testing: synthetic turns' replies and scores only, never logs. */
export function buildEvalResults(meta: EvalResultsMeta, outcomes: readonly ScenarioOutcome[], summary: EvalSummary, gated: boolean): EvalResults {
  const scored = outcomes.map((o) => o.scores).filter((s): s is JudgeScores => s !== null);
  const mean = scored.length > 0 ? summarizeScores(scored) : null;
  return {
    ...meta,
    gated,
    // Only the plan-a set is gated; other sets report the question ratio as a reference and skip avg chars.
    summary: gated
      ? { replies: summary.replies, questionRatio: round2(summary.questionRatio), questionRatioScope: summary.questionRatioScope, avgChars: round2(summary.avgChars), pass: summary.pass, failure: summary.failure }
      : { replies: summary.replies, questionRatio: round2(summary.questionRatio), failure: summary.failure },
    judge: meta.rubricFile === null ? null : {
      scored: scored.length,
      failures: outcomes.length - scored.length,
      mean,
      firstThreeMean: mean ? round2((mean.holdEmotion + mean.nameFeeling + mean.proactive) / 3) : null,
      noFabricationAllFive: scored.length === outcomes.length && scored.every((s) => s.noFabrication === 5),
    },
    results: outcomes.map((o) => ({
      id: o.scenario.id,
      title: o.scenario.title,
      silenceAfterMs: o.scenario.silenceAfterMs ?? null,
      scores: o.scores,
      replies: o.records.map((r) => ({
        turn: r.turn, kind: r.kind, text: r.text, chars: r.chars, sentences: r.sentences, questions: r.questions, firstAudioMs: r.firstAudioMs, mentioned: r.mentioned,
      })),
    })),
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(summary: EvalSummary, records: ReplyRecord[], meta: { adapter: string; character: string; date: string }): string {
  const rows = records.map((r) => `| ${r.scenarioId} | ${r.turn} | ${r.kind} | ${r.chars} | ${r.questions}/${r.sentences} | ${r.outputTokens ?? '-'} | ${r.firstAudioMs ?? '-'} | ${cell(r.text)} |`);
  return [
    `# Plan A eval — ${meta.adapter} / ${meta.character} — ${meta.date}`,
    '',
    'Synthetic scenarios: `docs/testing/plan-a-eval/scenarios.json`. Text input differs from voice; real voice trials decide.',
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| 回复数 | ${summary.replies} |`,
    `| ${summary.questionRatioScope === 'excluding-greeting' ? '问句比例（不含开场）' : '问句比例'} | ${summary.questionRatio.toFixed(3)} |`,
    `| 平均回复字数 | ${summary.avgChars.toFixed(1)} |`,
    `| 平均 output_tokens | ${summary.avgOutputTokens === null ? '-' : summary.avgOutputTokens.toFixed(1)} |`,
    `| 提及次数 | ${summary.mentions} |`,
    `| 问句比例达标 | ${summary.pass.questionRatio ? '是' : '否'} |`,
    `| 字数达标 | ${summary.pass.avgChars ? '是' : '否'} |`,
    '',
    '| 场景 | 轮 | 类型 | 字数 | 问句/句 | tokens | 首音 ms | 回复 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
