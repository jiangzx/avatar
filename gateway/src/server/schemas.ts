import { z } from 'zod';
import type { ClientMessage } from '@anyidea/protocol';

const seq = z.number().int().min(0).max(2 ** 32 - 1);
const ms = z.number().min(0).max(3_600_000);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start'), clientInfo: z.object({ platform: z.string().max(32), audioPath: z.enum(['A', 'B']) }) }),
  z.object({ type: z.literal('session.resume'), sessionId: z.string().max(64) }),
  z.object({ type: z.literal('vad'), state: z.enum(['speaking', 'silent']), t: z.number() }),
  z.object({ type: z.literal('playback.progress'), responseSeq: seq, playedMs: ms }),
  z.object({ type: z.literal('playback.stopped'), responseSeq: seq, playedMs: ms, reason: z.enum(['interrupted', 'ended']) }),
  z.object({ type: z.literal('client.mute'), muted: z.boolean() }),
  z.object({ type: z.literal('debug.userText'), text: z.string().min(1).max(500) }),
  z.object({ type: z.literal('session.end') }),
]);

export const ResumeRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  resumeToken: z.string().min(1).max(128),
});

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 8192) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ClientMessageSchema.safeParse(value);
  return result.success ? (result.data as ClientMessage) : null;
}
