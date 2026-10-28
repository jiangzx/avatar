import { z, ZodError } from 'zod';
import { AdminApiError, type ConfigAdminApi } from '../configApi.ts';
import { sendError, sendJson } from '../http.ts';
import type { AdminRoute, RouteContext } from './types.ts';

const BIG_BODY = 64 * 1024;
const Version = z.number().int().min(0).max(1_000_000_000);
const Key = z.string().min(3).max(120);
const Value = z.union([z.number().finite(), z.boolean(), z.string().max(20_000), z.array(z.string().max(500)).max(50)]);
const DraftSchema = z.object({
  baseVersion: Version,
  changes: z.array(z.object({ key: Key, value: Value }).strict()).max(200),
  resets: z.array(Key).max(200),
}).strict();
const PublishSchema = DraftSchema.extend({ note: z.string().max(100).optional(), confirmText: z.string().max(20).optional() }).strict();
const RollbackSchema = z.object({ toVersion: Version, baseVersion: Version }).strict();
const ResetSchema = z.object({ keys: z.union([z.literal('all'), z.array(Key).min(1).max(200)]), baseVersion: Version }).strict();
const SecretSchema = z.object({ value: z.string().max(512) }).strict();
const Micro = z.number().int().min(0).max(1_000_000_000_000);
const PriceSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.\-]{0,63}$/),
  effectiveFrom: z.number().int().min(0),
  inputText: Micro,
  inputAudio: Micro.nullable(),
  outputText: Micro,
  outputAudio: Micro.nullable(),
  cached: Micro.nullable(),
  source: z.string().min(1).max(300),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
const VersionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.number().int().min(1).optional(),
}).strict();

/** Runs one config call and maps refusals to AdminError bodies (config_invalid carries issues). */
async function run(ctx: RouteContext, call: (api: ConfigAdminApi, actor: string) => unknown | Promise<unknown>): Promise<void> {
  const api = ctx.deps.configAdmin;
  if (!api) {
    sendError(ctx.res, 404, 'not_found', '没有这个接口。');
    return;
  }
  try {
    sendJson(ctx.res, 200, await call(api, ctx.session!.actor));
  } catch (error) {
    if (error instanceof AdminApiError) {
      const body = { error: error.code, message: error.userMessage };
      sendJson(ctx.res, error.status, error.issues.length > 0 ? { ...body, issues: error.issues } : body);
      return;
    }
    if (error instanceof ZodError) {
      sendError(ctx.res, 400, 'bad_request', '请求格式不对。');
      return;
    }
    throw error;
  }
}

const route = (method: AdminRoute['method'], path: RegExp, name: string, handle: AdminRoute['handle'], bodyLimit?: number): AdminRoute =>
  ({ method, path, name, auth: true, ...(bodyLimit ? { bodyLimit } : {}), handle });

/** Config, key and price routes (spec「后台 HTTP API」). Login, same-origin and CSRF are checked by the admin server. */
export function configRoutes(): AdminRoute[] {
  return [
    route('GET', /^\/admin\/api\/config\/scenes$/, 'config_scenes', (ctx) => run(ctx, (api) => api.overview())),
    route('GET', /^\/admin\/api\/config\/scenes\/([a-z]{1,20})$/, 'config_scene', (ctx) => run(ctx, (api) => api.scene(ctx.params[0]!))),
    route('POST', /^\/admin\/api\/config\/preview$/, 'config_preview', (ctx) => run(ctx, async (api) => api.preview(DraftSchema.parse(await ctx.body()))), BIG_BODY),
    route('POST', /^\/admin\/api\/config\/publish$/, 'config_publish', (ctx) => run(ctx, async (api, actor) => api.publish(PublishSchema.parse(await ctx.body()), actor)), BIG_BODY),
    route('GET', /^\/admin\/api\/config\/versions$/, 'config_versions', (ctx) => run(ctx, (api) => {
      const query = VersionQuery.parse(Object.fromEntries(ctx.url.searchParams));
      return api.versions(query.limit, query.before);
    })),
    route('GET', /^\/admin\/api\/config\/versions\/(\d{1,9})\/diff$/, 'config_version_diff', (ctx) => run(ctx, (api) => api.versionDiff(Number(ctx.params[0])))),
    route('POST', /^\/admin\/api\/config\/rollback$/, 'config_rollback', (ctx) => run(ctx, async (api, actor) => api.rollback(RollbackSchema.parse(await ctx.body()), actor))),
    route('POST', /^\/admin\/api\/config\/reset$/, 'config_reset', (ctx) => run(ctx, async (api, actor) => api.reset(ResetSchema.parse(await ctx.body()), actor))),
    route('GET', /^\/admin\/api\/secrets$/, 'secrets', (ctx) => run(ctx, (api) => api.secretList())),
    route('PUT', /^\/admin\/api\/secrets\/([A-Z_]{1,40})$/, 'secret_put', (ctx) => run(ctx, async (api, actor) => api.putSecret(ctx.params[0]!, SecretSchema.parse(await ctx.body()).value, actor))),
    route('POST', /^\/admin\/api\/secrets\/([A-Z_]{1,40})\/reveal$/, 'secret_reveal', (ctx) => run(ctx, (api, actor) => api.revealSecret(ctx.params[0]!, actor))),
    route('GET', /^\/admin\/api\/pricing$/, 'pricing', (ctx) => run(ctx, (api) => api.pricing())),
    route('POST', /^\/admin\/api\/pricing$/, 'price_add', (ctx) => run(ctx, async (api, actor) => api.addPrice(PriceSchema.parse(await ctx.body()), actor))),
  ];
}
