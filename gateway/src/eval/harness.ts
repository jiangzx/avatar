import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AI_SAMPLE_RATE, type ResponseKind, type ServerMessage } from '@anyidea/protocol';
import type { ReplyMetrics } from '../session/metrics.ts';
import type { Session, Transport } from '../session/session.ts';
import { countQuestions, type QuestionRule } from './questions.ts';

const EvalConfigSchema = z.object({
  question: z.object({
    endMarks: z.array(z.string().min(1)).min(1),
    finalParticles: z.array(z.string().length(1)),
    neParticle: z.string().length(1),
    interrogatives: z.array(z.string().min(1)),
    quotePairs: z.array(z.tuple([z.string().length(1), z.string().length(1)])),
  }).strict(),
  gate: z.object({ maxQuestionRatio: z.number().gt(0).max(1), maxAvgReplyChars: z.number().int().min(5).max(500) }).strict(),
  run: z.object({
    playbackSpeed: z.number().gt(0).max(50),
    settleMs: z.number().int().min(10).max(10_000),
    replyTimeoutMs: z.number().int().min(100).max(120_000),
    progressEveryMs: z.number().int().min(10).max(5_000),
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
class SimTransport implements Transport {
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

interface Played { seq: number; kind: ResponseKind; firstAudioMs: number | null }

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

/** Plays every response of one exchange (a tool continuation may follow within settleMs). */
async function playResponses(session: Session, t: SimTransport, run: EvalConfig['run'], sentAt: number | null): Promise<Played[]> {
  const out: Played[] = [];
  let wait = run.replyTimeoutMs;
  for (;;) {
    const start = await t.next((m) => m.type === 'response.start', wait);
    if (!start || start.type !== 'response.start') return out;
    const seq = start.responseSeq;
    const end = await t.next((m) => (m.type === 'response.end' || m.type === 'response.cancelled') && m.responseSeq === seq, run.replyTimeoutMs);
    if (end?.type === 'response.end') await simulatePlayback(session, seq, t.audioMs.get(seq) ?? 0, run);
    const first = t.firstAudioAt.get(seq);
    out.push({ seq, kind: start.kind, firstAudioMs: first !== undefined && sentAt !== null ? first - sentAt : null });
    wait = run.settleMs;
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
  } finally {
    session.end();
  }
  return records;
}

export interface EvalSummary {
  replies: number;
  sentences: number;
  questions: number;
  questionRatio: number;
  avgChars: number;
  avgOutputTokens: number | null;
  mentions: number;
  pass: { questionRatio: boolean; avgChars: boolean };
  /** Content-free reason the run is invalid regardless of the gate; null when fine. */
  failure: string | null;
}

export function summarize(records: ReplyRecord[], gate: EvalConfig['gate']): EvalSummary {
  const sentences = records.reduce((n, r) => n + r.sentences, 0);
  const questions = records.reduce((n, r) => n + r.questions, 0);
  const tokens = records.map((r) => r.outputTokens).filter((v): v is number => v !== null);
  const questionRatio = sentences === 0 ? 0 : questions / sentences;
  const avgChars = records.length === 0 ? 0 : records.reduce((n, r) => n + r.chars, 0) / records.length;
  return {
    replies: records.length, sentences, questions, questionRatio, avgChars,
    avgOutputTokens: tokens.length === 0 ? null : tokens.reduce((a, b) => a + b, 0) / tokens.length,
    mentions: records.filter((r) => r.mentioned).length,
    pass: { questionRatio: questionRatio <= gate.maxQuestionRatio, avgChars: avgChars <= gate.maxAvgReplyChars },
    failure: records.length === 0 ? 'no replies' : null,
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(summary: EvalSummary, records: ReplyRecord[], meta: { adapter: string; style: string; date: string }): string {
  const rows = records.map((r) => `| ${r.scenarioId} | ${r.turn} | ${r.kind} | ${r.chars} | ${r.questions}/${r.sentences} | ${r.outputTokens ?? '-'} | ${r.firstAudioMs ?? '-'} | ${cell(r.text)} |`);
  return [
    `# Plan A eval — ${meta.adapter} / ${meta.style} — ${meta.date}`,
    '',
    'Synthetic scenarios: `docs/testing/plan-a-eval/scenarios.json`. Text input differs from voice; real voice trials decide.',
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| 回复数 | ${summary.replies} |`,
    `| 问句比例 | ${summary.questionRatio.toFixed(3)} |`,
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
