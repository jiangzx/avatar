import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAudit } from '../audit.ts';
import type { LoginGuard } from '../loginGuard.ts';
import type { AdminQueries } from '../queries.ts';
import type { AdminDeps } from '../server.ts';
import type { AdminSession, AdminSessionStore } from '../sessions.ts';

export interface AdminServices { sessions: AdminSessionStore; guard: LoginGuard; audit: AdminAudit; queries: AdminQueries; now: () => number }

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: readonly string[];
  session: AdminSession | null;
  deps: AdminDeps;
  services: AdminServices;
  body(): Promise<unknown>;
}

export interface AdminRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: RegExp;
  name: string;
  auth: boolean;
  bodyLimit?: number;
  handle(ctx: RouteContext): Promise<void> | void;
}
