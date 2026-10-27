import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parsePasswordHash } from './password.ts';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const SinkSchema = z.object({ flushMs: int(100, 60_000), maxBatch: int(1, 5_000) }).strict();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const AdminConfigSchema = z
  .object({
    retention: z.object({ usageDays: int(1, 3650), logDays: int(1, 90), auditDays: int(1, 3650) }).strict(),
    logSink: SinkSchema,
    usageSink: SinkSchema,
    session: z.object({ idleMs: int(MINUTE, DAY), absoluteMs: int(MINUTE, 7 * DAY) }).strict(),
    login: z.object({ maxFailures: int(1, 20), windowMs: int(MINUTE, DAY), lockMs: int(MINUTE, DAY) }).strict(),
    alerts: z.object({ errorRate1h: z.number().gt(0).lte(1), firstAudioP95Ms: int(100, 60_000), minSamples: int(1, 1000) }).strict(),
    logLevelOverrideMs: int(MINUTE, DAY),
    // Lets the owner_banned WS error reach the app before the socket is dropped (P2-T5).
    banCloseDelayMs: int(0, 5_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.session.absoluteMs < value.session.idleMs) {
      ctx.addIssue({ code: 'custom', path: ['session', 'absoluteMs'], message: 'absoluteMs must be >= idleMs' });
    }
  });

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export function loadAdminConfig(path: string): AdminConfig {
  return AdminConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export type AdminEnv =
  | { enabled: true; port: number; passwordHash: string }
  | { enabled: false; reason: 'admin_port_unset' | 'admin_port_invalid' | 'admin_password_hash_unset' | 'admin_password_hash_invalid' };

/** The admin port is opt-in: no ADMIN_PORT, no admin server. */
export function loadAdminEnv(env: NodeJS.ProcessEnv): AdminEnv {
  const rawPort = env.ADMIN_PORT?.trim();
  if (!rawPort) return { enabled: false, reason: 'admin_port_unset' };
  if (!/^[0-9]{1,5}$/.test(rawPort)) return { enabled: false, reason: 'admin_port_invalid' };
  const port = Number(rawPort);
  if (port < 1024 || port > 65535) return { enabled: false, reason: 'admin_port_invalid' };
  const passwordHash = env.ADMIN_PASSWORD_HASH?.trim();
  if (!passwordHash) return { enabled: false, reason: 'admin_password_hash_unset' };
  if (!parsePasswordHash(passwordHash)) return { enabled: false, reason: 'admin_password_hash_invalid' };
  return { enabled: true, port, passwordHash };
}
