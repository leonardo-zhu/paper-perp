import pino from 'pino';
import type { Config } from './config';

export type Logger = pino.Logger;

export function createLogger(cfg: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV' | 'APP_ENV' | 'RELEASE'>) {
  const pretty = cfg.NODE_ENV === 'development' && process.stdout.isTTY;
  return pino({
    level: cfg.NODE_ENV === 'test' ? 'silent' : cfg.LOG_LEVEL,
    base: { env: cfg.APP_ENV, release: cfg.RELEASE },
    // Signatures are not secret, but they are noise and long; session ids are secret.
    redact: {
      paths: ['signature', '*.signature', 'sessionId', 'cookie', '*.cookie'],
      remove: true,
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}
