import { serveStatic } from '@hono/node-server/serve-static';
import {
  type ApproveAgentMessage,
  approveAgentBodySchema,
  type CancelMessage,
  cancelOrderBodySchema,
  type ErrorCode,
  errorMessage,
  isMarketSymbol,
  MARKETS,
  type OrderMessage,
  placeOrderBodySchema,
  STARTING_BALANCE_USDC,
  SYMBOLS,
  siweVerifyBodySchema,
} from '@paperperp/shared';
import * as Sentry from '@sentry/node';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service';
import type { Config } from '../config';
import type { SessionRow, Store } from '../db/store';
import { AppError } from '../errors';
import type { Logger } from '../logger';
import type { MarketService } from '../market/market-service';
import type { FaultKind } from '../market/venue';
import type { Metrics } from '../metrics';
import type { TradingEngine } from '../trading/engine';
import { rateLimit } from './rate-limit';

export const SESSION_COOKIE = 'pp_session';

export interface AppDeps {
  cfg: Config;
  log: Logger;
  metrics: Metrics;
  store: Store;
  auth: AuthService;
  engine: TradingEngine;
  market: Pick<
    MarketService,
    'status' | 'snapshotMessage' | 'candles' | 'injectFault' | 'venueName' | 'epoch'
  >;
  wsClients: () => number;
  clientIp: (c: Context) => string;
}

type Env = { Variables: { session: SessionRow | undefined; requestId: string } };

export function createApp(deps: AppDeps) {
  const { cfg, log, metrics, auth, engine, market } = deps;
  const app = new Hono<Env>();

  app.use(requestId());
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    const route = c.req.routePath || 'unmatched';
    const seconds = (performance.now() - start) / 1000;
    metrics.httpDuration.observe(
      { method: c.req.method, route, status: String(c.res.status) },
      seconds,
    );
    if (route !== '/healthz' && route !== '/metrics') {
      log.info(
        {
          requestId: c.get('requestId'),
          method: c.req.method,
          route,
          status: c.res.status,
          ms: Math.round(seconds * 1000),
          account: c.get('session')?.address,
        },
        'http',
      );
    }
  });
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React style attributes and lightweight-charts need inline styles.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: [
          "'self'",
          'wss:',
          'https://*.ingest.sentry.io',
          'https://*.ingest.us.sentry.io',
        ],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'none'"],
      },
    }),
  );
  app.use(
    '/api/*',
    cors({ origin: cfg.ALLOWED_ORIGINS, credentials: true, allowHeaders: ['content-type'] }),
  );
  app.use('/api/*', csrf({ origin: cfg.ALLOWED_ORIGINS }));
  app.use('/api/*', bodyLimit({ maxSize: 32 * 1024 }));
  app.use('/api/*', async (c, next) => {
    c.set('session', auth.session(getCookie(c, SESSION_COOKIE)));
    await next();
  });

  const ipLimit = (limit: number, windowMs: number) =>
    rateLimit({ limit, windowMs, key: (c) => `ip:${deps.clientIp(c)}` });
  const accountLimit = (limit: number, windowMs: number) =>
    rateLimit({ limit, windowMs, key: (c) => `acct:${c.get('session')?.address}` });

  const requireSession = async (c: Context<Env>, next: () => Promise<void>) => {
    if (!c.get('session')) throw new AppError('unauthorized');
    await next();
  };
  const session = (c: Context<Env>) => c.get('session')!;

  // ---------------------------------------------------------------- ops

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) => {
    const markets = Object.fromEntries(SYMBOLS.map((s) => [s, market.status(s)]));
    const dbOk = deps.store.ping();
    // Not ready until the first market snapshot arrived; stale is still "ready"
    // (the app degrades to read-only rather than going down).
    const ready = dbOk && Object.values(markets).every((s) => s !== 'reconnecting');
    return c.json(
      { ready, db: dbOk, markets, venue: market.venueName, wsClients: deps.wsClients() },
      ready ? 200 : 503,
    );
  });
  app.get('/metrics', async (c) => {
    c.header('content-type', metrics.registry.contentType);
    return c.body(await metrics.registry.metrics());
  });

  // ---------------------------------------------------------------- markets

  app.get('/api/markets', (c) =>
    c.json({
      venue: market.venueName,
      chainId: cfg.CHAIN_ID,
      markets: SYMBOLS.map((s) => ({ ...MARKETS[s], status: market.status(s) })),
    }),
  );
  app.get('/api/markets/:symbol/book', (c) => {
    const symbol = c.req.param('symbol');
    if (!isMarketSymbol(symbol)) throw new AppError('unknown_market');
    return c.json(market.snapshotMessage(symbol));
  });
  app.get('/api/markets/:symbol/klines', (c) => {
    const symbol = c.req.param('symbol');
    if (!isMarketSymbol(symbol)) throw new AppError('unknown_market');
    c.header('cache-control', 'public, max-age=2');
    return c.json({ symbol, interval: '1m', candles: market.candles(symbol) });
  });

  // ---------------------------------------------------------------- auth

  app.get('/api/auth/nonce', ipLimit(30, 60_000), (c) => {
    c.header('cache-control', 'no-store');
    return c.json({ nonce: auth.issueNonce() });
  });
  app.post('/api/auth/verify', ipLimit(20, 60_000), async (c) => {
    const body = await parse(c, siweVerifyBodySchema);
    const s = await auth.verify(body.message, body.signature);
    setCookie(c, SESSION_COOKIE, s.id, {
      httpOnly: true,
      secure: cfg.COOKIE_SECURE,
      sameSite: 'Lax',
      path: '/',
      expires: new Date(s.expiresAt),
    });
    log.info({ requestId: c.get('requestId'), account: s.address }, 'signed in');
    return c.json({ address: s.address, chainId: s.chainId, expiresAt: s.expiresAt });
  });
  app.get('/api/auth/session', (c) => {
    c.header('cache-control', 'no-store');
    const s = c.get('session');
    if (!s) throw new AppError('unauthorized');
    return c.json({ address: s.address, chainId: s.chainId, expiresAt: s.expiresAt });
  });
  app.post('/api/auth/logout', (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) auth.logout(id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- account & trading

  app.get('/api/account', requireSession, (c) => {
    const address = session(c).address;
    return c.json({
      account: engine.accountDTO(address),
      positions: engine.positionsDTO(address),
    });
  });
  app.post('/api/account/reset', requireSession, accountLimit(5, 60_000), (c) => {
    const address = session(c).address;
    engine.resetAccount(address, STARTING_BALANCE_USDC);
    return c.json({ account: engine.accountDTO(address), positions: [] });
  });
  app.get('/api/orders', requireSession, (c) =>
    c.json({ orders: deps.store.listOrders(session(c).address, 100) }),
  );
  app.get('/api/fills', requireSession, (c) =>
    c.json({ fills: deps.store.listFills(session(c).address, 100) }),
  );
  app.post('/api/orders', requireSession, accountLimit(20, 1_000), async (c) => {
    const body = await parse(c, placeOrderBodySchema);
    const res = await engine.placeOrder(session(c), {
      order: body.order as OrderMessage,
      signature: body.signature,
      chainId: body.chainId,
    });
    return c.json(res, res.duplicate ? 200 : 201);
  });
  app.post('/api/orders/cancel', requireSession, accountLimit(20, 1_000), async (c) => {
    const body = await parse(c, cancelOrderBodySchema);
    const order = await engine.cancelOrder(session(c), {
      cancel: body.cancel as CancelMessage,
      signature: body.signature,
      chainId: body.chainId,
    });
    return c.json({ order });
  });
  app.get('/api/agents', requireSession, (c) =>
    c.json({ agents: engine.listAgents(session(c).address) }),
  );
  app.post('/api/agents', requireSession, accountLimit(10, 60_000), async (c) => {
    const body = await parse(c, approveAgentBodySchema);
    const agent = await engine.approveAgent(session(c), {
      approval: body.approval as ApproveAgentMessage,
      signature: body.signature,
      chainId: body.chainId,
    });
    return c.json({ agent });
  });

  // ---------------------------------------------------------------- chaos (dev/staging only)

  if (cfg.ENABLE_FAULT_INJECTION) {
    const faultSchema = z.object({
      kind: z.enum(['disconnect', 'gap', 'freeze']),
      ms: z.number().int().min(100).max(60_000).optional(),
    });
    app.post('/api/dev/fault', async (c) => {
      const body = await parse(c, faultSchema);
      market.injectFault(body.kind as FaultKind, body.ms);
      return c.json({ ok: true, ...body });
    });
  }

  // ---------------------------------------------------------------- errors

  // ---------------------------------------------------------------- web app (single-container mode)

  if (cfg.STATIC_DIR) {
    const root = cfg.STATIC_DIR;
    app.use(
      '/assets/*',
      serveStatic({
        root,
        onFound: (_path, c) => c.header('cache-control', 'public, max-age=31536000, immutable'),
      }),
    );
    app.use('*', serveStatic({ root }));
    // SPA fallback for client routes; never for API paths.
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) return next();
      c.header('cache-control', 'no-cache');
      return serveStatic({ root, path: 'index.html' })(c, next);
    });
  }

  app.notFound((c) => c.json(errorBody('not_found', errorMessage('not_found'), c), 404));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ ...errorBody(err.code, err.message, c), ...err.details }, err.status);
    }
    Sentry.captureException(err, { tags: { requestId: c.get('requestId') } });
    log.error({ err, requestId: c.get('requestId') }, 'unhandled error');
    return c.json(errorBody('internal', errorMessage('internal'), c), 500);
  });

  return app;
}

function errorBody(code: ErrorCode, message: string, c: Context<Env>) {
  return { error: { code, message, requestId: c.get('requestId') } };
}

async function parse<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new AppError('invalid_request', 'body must be JSON');
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new AppError(
      'invalid_request',
      issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body',
    );
  }
  return res.data;
}
