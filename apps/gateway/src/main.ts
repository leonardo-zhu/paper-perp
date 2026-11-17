import type { IncomingMessage, Server } from 'node:http';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { channels, type MarketSymbol, type ServerMessage } from '@paperperp/shared';
import * as Sentry from '@sentry/node';
import type { Context } from 'hono';
import { AuthService } from './auth/auth-service';
import { loadConfig } from './config';
import { openDatabase } from './db/sqlite';
import { Store } from './db/store';
import { createApp, SESSION_COOKIE } from './http/app';
import { createLogger } from './logger';
import { BinanceVenue } from './market/binance';
import { HyperliquidVenue } from './market/hyperliquid';
import { MarketService } from './market/market-service';
import { MockVenue } from './market/mock';
import type { MarketVenue } from './market/venue';
import { createMetrics } from './metrics';
import { TradingEngine } from './trading/engine';
import { Hub } from './ws/hub';

const cfg = loadConfig();
const log = createLogger(cfg);
const metrics = createMetrics();

if (cfg.SENTRY_DSN) {
  Sentry.init({ dsn: cfg.SENTRY_DSN, environment: cfg.APP_ENV, release: cfg.RELEASE });
}

const store = new Store(openDatabase(cfg.DATABASE_PATH));
const auth = new AuthService(store, {
  chainId: cfg.CHAIN_ID,
  siweDomains: cfg.SIWE_DOMAINS,
  allowedOrigins: cfg.ALLOWED_ORIGINS,
  sessionTtlMs: cfg.SESSION_TTL_HOURS * 3_600_000,
});

const venue: MarketVenue =
  cfg.MARKET_SOURCE === 'binance'
    ? new BinanceVenue({ log, metrics })
    : cfg.MARKET_SOURCE === 'hyperliquid'
      ? new HyperliquidVenue({ log, metrics })
      : new MockVenue();

// The hub needs the market (for snapshots) and the market needs a publisher
// (the hub); break the cycle with a late-bound publisher.
let hub: Hub | null = null;
const market = new MarketService(
  venue,
  { log, metrics, staleAfterMs: cfg.STALE_AFTER_MS },
  { publish: (channel, msg) => hub?.publish(channel, msg) },
);

const engine = new TradingEngine({
  store,
  market,
  chainId: cfg.CHAIN_ID,
  log,
  metrics,
  events: {
    order: (order) => hub?.sendToAccount(order.account, { type: 'order', order }),
    fill: (account, fill) => hub?.sendToAccount(account, { type: 'fill', fill }),
    position: (account, position) => hub?.sendToAccount(account, { type: 'position', position }),
    account: (account) => hub?.sendToAccount(account.address, { type: 'account', account }),
  },
});
market.onBookChange = (symbol) => engine.onBookChange(symbol);

function ipFromRequest(req: IncomingMessage): string {
  if (cfg.TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function ipFromContext(c: Context): string {
  if (cfg.TRUST_PROXY) {
    const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }
  return getConnInfo(c).remote.address ?? 'unknown';
}

hub = new Hub({
  log,
  metrics,
  epoch: market.epoch,
  allowedOrigins: cfg.ALLOWED_ORIGINS,
  clientIp: ipFromRequest,
  authenticate: (req) => {
    const cookie = req.headers.cookie ?? '';
    const id = cookie
      .split(';')
      .map((p) => p.trim().split('='))
      .find(([k]) => k === SESSION_COOKIE)?.[1];
    return auth.session(id ? decodeURIComponent(id) : undefined)?.address ?? null;
  },
  initialMessages: (channel, account): ServerMessage[] => {
    if (channel === channels.account) return account ? engine.initialAccountMessages(account) : [];
    if (channel === channels.tickers) return [market.tickersMessage()];
    const [kind, symbol] = channel.split(':') as [string, MarketSymbol];
    if (kind === 'book') return [market.statusMessage(symbol), market.snapshotMessage(symbol)];
    if (kind === 'trades') return [market.tradesMessage(symbol)];
    return [];
  },
});

const app = createApp({
  cfg,
  log,
  metrics,
  store,
  auth,
  engine,
  market,
  wsClients: () => hub?.size ?? 0,
  clientIp: ipFromContext,
});

// Listen first: the port must be open as soon as possible after a restart
// (the reverse proxy is retrying). /readyz stays 503 until market data arrives.
const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => {
  log.info({ port: info.port, venue: venue.name, chainId: cfg.CHAIN_ID }, 'gateway listening');
}) as Server;
hub.attach(server);
void market.start();

const purge = setInterval(() => store.purgeExpired(Date.now()), 10 * 60_000);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  clearInterval(purge);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  market.stop();
  hub?.close();
  // Stop accepting, then drop idle keep-alive sockets right away so the
  // process exits in well under a second instead of waiting for browsers
  // to hang up. In-flight requests still finish.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const hard = setTimeout(() => server.closeAllConnections(), 3_000);
  await closed;
  clearTimeout(hard);
  store.db.close();
  await Sentry.flush(2_000);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'unhandled rejection');
  Sentry.captureException(err);
});
