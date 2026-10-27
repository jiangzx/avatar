import { z } from 'zod';
import { CHARACTER_IDS, type ClientMessage } from '@anyidea/protocol';

const seq = z.number().int().min(0).max(2 ** 32 - 1);
const ms = z.number().min(0).max(3_600_000);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start'), clientInfo: z.object({ platform: z.string().max(32), audioPath: z.enum(['A', 'B']), language: z.enum(['zh', 'ja', 'en']).optional() }) }),
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

/** POST /device/register. clientInfo is validated but not stored (data minimization). */
export const RegisterRequestSchema = z.object({
  clientInfo: z.object({ platform: z.string().min(1).max(32) }),
});

/** POST /session. Only the character; owner and agent come from the bearer. Missing = DEFAULT_CHARACTER_ID. */
export const SessionCreateSchema = z.object({ character: z.enum(CHARACTER_IDS).optional() }).strict();

/** DELETE /dev/owner/:id. */
export const OwnerIdSchema = z.uuid();

/** Settings addressing (spec §7): 1–20 characters after trim, counted as code points. */
export const ADDRESSING_MAX_CHARS = 20;

/** PUT /memory/addressing. */
export const AddressingRequestSchema = z.object({
  text: z.string().max(200).refine((text) => {
    const length = [...text.trim()].length;
    return length >= 1 && length <= ADDRESSING_MAX_CHARS;
  }),
}).strict();

/** DELETE /memory/items/:id. */
export const MemoryItemIdSchema = z.uuid();

/** DELETE /memory?scope=...; character only with scope=character, and only a registered id. */
export const MemoryClearQuerySchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('profile') }).strict(),
  z.object({ scope: z.literal('character'), character: z.enum(CHARACTER_IDS) }).strict(),
  z.object({ scope: z.literal('all') }).strict(),
]);
