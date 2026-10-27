import { readFileSync } from 'node:fs';
import { z } from 'zod';

const days = (max: number) => z.number().int().min(1).max(max);
const sink = z.object({
  flushMs: z.number().int().min(100).max(60_000),
  maxBatch: z.number().int().min(1).max(5_000),
}).strict();

/** gateway/config/admin.json. Later tasks extend this one schema (session, login, alerts). */
export const AdminConfigSchema = z.object({
  retention: z.object({
    usageDays: days(3650),
    logDays: days(90),
    auditDays: days(3650),
  }).strict(),
  logSink: sink,
  usageSink: sink,
}).strict();

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export function loadAdminConfig(path: string): AdminConfig {
  return AdminConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
