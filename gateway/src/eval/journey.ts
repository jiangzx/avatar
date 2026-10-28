import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CHARACTER_IDS } from '@anyidea/protocol';

export const DAY_MS = 86_400_000;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const JourneySessionSchema = z.object({
  /** Days after the journey start (0 = first day). */
  day: z.number().int().min(0).max(13),
  /** Asia/Shanghai wall time, HH:mm. */
  time: Time,
  /** Defaults to the journey character. */
  character: z.enum(CHARACTER_IDS).optional(),
  /** What the user says, in order. Empty = the user only listens. */
  turns: z.array(z.string().min(1).max(200)).max(10),
  /** After the last turn, keep collecting proactive lines this long. */
  silenceAfterMs: z.number().int().min(1_000).max(60_000).optional(),
  /** What this session tests; shown to the judge, never spoken. */
  note: z.string().min(1).max(80).optional(),
}).strict();

const minuteOf = (s: { day: number; time: string }) => {
  const [h, m] = s.time.split(':').map(Number);
  return s.day * 1440 + h! * 60 + m!;
};

const JourneySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().min(1).max(40),
  character: z.enum(CHARACTER_IDS),
  /** First day, YYYY-MM-DD (Asia/Shanghai). */
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessions: z.array(JourneySessionSchema).min(2).max(8),
}).strict().superRefine((j, ctx) => {
  // Rejects 2026-13-40 (Invalid Date) and 2026-02-30 (JS rolls it over to March).
  const at = Date.parse(`${j.start}T00:00:00+08:00`);
  if (Number.isNaN(at) || shanghaiDate(at) !== j.start) {
    ctx.addIssue({ code: 'custom', path: ['start'], message: 'start must be a real calendar date' });
  }
  for (let i = 1; i < j.sessions.length; i++) {
    if (minuteOf(j.sessions[i]!) <= minuteOf(j.sessions[i - 1]!)) {
      ctx.addIssue({ code: 'custom', path: ['sessions', i], message: 'sessions must be in strictly increasing day/time order' });
    }
  }
});

export type JourneySession = z.infer<typeof JourneySessionSchema>;
export type Journey = z.infer<typeof JourneySchema>;

/** YYYY-MM-DD of an instant in Asia/Shanghai (UTC+8, no DST). */
function shanghaiDate(at: number): string {
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function parseJourneys(raw: unknown): Journey[] {
  const journeys = z.array(JourneySchema).min(1).parse(raw);
  const seen = new Set<string>();
  for (const j of journeys) {
    if (seen.has(j.id)) throw new Error(`duplicate journey id ${j.id}`);
    seen.add(j.id);
  }
  return journeys;
}

export function loadJourneys(path: string): Journey[] {
  return parseJourneys(JSON.parse(readFileSync(path, 'utf8')));
}

/** Epoch ms when the session starts, from the journey start date and the session's day and wall time. */
export function sessionStartAt(journey: Journey, session: JourneySession): number {
  return Date.parse(`${journey.start}T${session.time}:00+08:00`) + session.day * DAY_MS;
}
