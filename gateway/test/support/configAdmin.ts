import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { AdminAudit } from '../../src/admin/audit.ts';
import { ConfigAdminApi } from '../../src/admin/configApi.ts';
import { loadConfig } from '../../src/config.ts';
import { loadDescriptorCatalog } from '../../src/config-store/descriptors.ts';
import type { ModelDefaults, Overlay } from '../../src/config-store/keys.ts';
import { loadQwenOptions } from '../../src/config-store/options.ts';
import { SqliteSecretStore } from '../../src/config-store/secrets.ts';
import { SqliteConfigStore } from '../../src/config-store/store.ts';
import { defaultLogger } from '../../src/log/logger.ts';
import { buildConfigSnapshot, type ConfigSnapshot } from '../../src/session/configSnapshot.ts';
import { SqlitePriceBook, loadPricingBaseline } from '../../src/usage/pricing.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
export const TEST_MODELS: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/chat',
  summarizerModel: 'qwen-flash',
};
const catalog = loadDescriptorCatalog(`${root}config/admin/descriptors`, { languages: LANGUAGES, characters: CHARACTER_IDS });
const options = loadQwenOptions(`${root}config/admin/qwen-options.json`);

export interface BuildConfigAdminOptions {
  activeSessions?: () => number;
  masterKey?: Buffer | null;            // null = read-only key store
  env?: Record<string, string>;
  now?: () => number;
}

/** A real ConfigAdminApi on the given DB, with the shipped descriptors and prices. */
export function buildConfigAdmin(db: DatabaseSync, opts: BuildConfigAdminOptions = {}) {
  const build = (overlay: Overlay, version: number): ConfigSnapshot =>
    buildConfigSnapshot({ gatewayRoot: root, overlay, version, ledger: env.ledger, sessionStartTimeoutMs: env.sessionStartTimeoutMs, models: TEST_MODELS });
  const store = new SqliteConfigStore<ConfigSnapshot>({ db, build, logger: defaultLogger() });
  const secrets = new SqliteSecretStore({
    db,
    masterKey: opts.masterKey === undefined ? randomBytes(32) : opts.masterKey,
    env: opts.env ?? { DASHSCOPE_API_KEY: 'env-key-00001111' },
    logger: defaultLogger(),
  });
  const prices = new SqlitePriceBook(db, loadPricingBaseline(`${root}config/pricing.json`));
  const api = new ConfigAdminApi({
    db, store, catalog, options, secrets, prices,
    audit: new AdminAudit(db, defaultLogger(), opts.now),
    gatewayRoot: root, models: TEST_MODELS,
    activeSessions: opts.activeSessions ?? (() => 0),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { api, store, secrets };
}
