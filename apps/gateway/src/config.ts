import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const list = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Deployment environment, used for log/metric labels and Sentry. */
  APP_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
  RELEASE: z.string().default('dev'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8787),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_PATH: z.string().default('./data/paperperp.db'),
  MARKET_SOURCE: z.enum(['binance', 'hyperliquid', 'mock']).default('binance'),
  /** Chain the EIP-712 domain and SIWE messages are bound to. Default: Arbitrum Sepolia. */
  CHAIN_ID: z.coerce.number().int().default(421614),
  /** Browser origins allowed for CORS, CSRF and WebSocket upgrades. */
  ALLOWED_ORIGINS: list.default(['http://localhost:5173']),
  /** host[:port] values accepted as the SIWE `domain`. */
  SIWE_DOMAINS: list.default(['localhost:5173']),
  SESSION_TTL_HOURS: z.coerce.number().default(24),
  COOKIE_SECURE: bool.optional(),
  /** Trust X-Forwarded-For (only behind our own reverse proxy). */
  TRUST_PROXY: bool.default(false),
  STALE_AFTER_MS: z.coerce.number().int().default(5_000),
  ENABLE_FAULT_INJECTION: bool.default(false),
  SENTRY_DSN: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { COOKIE_SECURE: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  return { ...cfg, COOKIE_SECURE: cfg.COOKIE_SECURE ?? cfg.NODE_ENV === 'production' };
}
