import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory limiter. Good enough for a single gateway
 * instance; with several replicas this moves to Redis (see ADR-0005).
 */
export function rateLimit(opts: {
  limit: number;
  windowMs: number;
  key: (c: Parameters<MiddlewareHandler>[0]) => string;
}): MiddlewareHandler {
  const windows = new Map<string, Window>();
  let lastSweep = Date.now();
  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      lastSweep = now;
    }
    const key = opts.key(c);
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + opts.windowMs };
      windows.set(key, w);
    }
    w.count++;
    c.header('RateLimit-Limit', String(opts.limit));
    c.header('RateLimit-Remaining', String(Math.max(0, opts.limit - w.count)));
    if (w.count > opts.limit) {
      c.header('Retry-After', String(Math.ceil((w.resetAt - now) / 1000)));
      throw new AppError('rate_limited');
    }
    await next();
  };
}
