import type { Candle, Level, MarketSymbol, TradeDTO } from '@paperperp/shared';
import WebSocket from 'ws';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';

/** Normalised callbacks every venue adapter drives. */
export interface VenueSink {
  /** `snapshot` replaces the book; `delta` updates levels (size 0 = remove). */
  onBook(
    symbol: MarketSymbol,
    kind: 'snapshot' | 'delta',
    bids: Level[],
    asks: Level[],
    ts: number,
  ): void;
  onTrades(symbol: MarketSymbol, trades: TradeDTO[]): void;
  onKline(symbol: MarketSymbol, candle: Candle): void;
  onConnection(connected: boolean, reason: string | null): void;
}

export type FaultKind = 'disconnect' | 'gap' | 'freeze';

export interface MarketVenue {
  readonly name: string;
  start(sink: VenueSink): void;
  stop(): void;
  fetchKlines(symbol: MarketSymbol, limit: number): Promise<Candle[]>;
  /** Chaos testing hook: drop the connection, lose a message, or go silent. */
  injectFault(kind: FaultKind, ms?: number): void;
}

export interface VenueDeps {
  log: Logger;
  metrics: Metrics;
}

interface SocketOptions {
  url: string;
  venue: string;
  /** Reconnect if nothing arrives for this long. */
  idleTimeoutMs: number;
  onOpen(ws: WebSocket): void;
  onMessage(data: string): void;
  onClose(reason: string): void;
}

/**
 * Upstream WebSocket with exponential backoff + full jitter and an idle
 * watchdog (a TCP connection can stay "open" while delivering nothing).
 */
export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private idleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  /** While set, incoming messages are discarded (fault injection: "freeze"). */
  frozenUntil = 0;

  constructor(
    private readonly opts: SocketOptions,
    private readonly deps: VenueDeps,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
  }

  /** Kill the current connection; the normal reconnect path takes over. */
  drop(reason: string): void {
    if (!this.ws) return;
    this.deps.log.warn({ venue: this.opts.venue, reason }, 'dropping upstream connection');
    this.ws.terminate();
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  private connect(): void {
    const { url, venue } = this.opts;
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.deps.log.info({ venue }, 'upstream connected');
      this.armIdle();
      this.opts.onOpen(ws);
    });
    ws.on('message', (raw) => {
      if (Date.now() < this.frozenUntil) return;
      this.armIdle();
      this.opts.onMessage(raw.toString());
    });
    ws.on('error', (err) => this.deps.log.warn({ venue, err: err.message }, 'upstream error'));
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.opts.onClose(`closed (${code})`);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const base = Math.min(30_000, 500 * 2 ** this.attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.attempt++;
    this.deps.metrics.upstreamReconnects.inc({ venue: this.opts.venue });
    this.deps.log.info({ venue: this.opts.venue, delay, attempt: this.attempt }, 'reconnecting');
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.drop('idle timeout'), this.opts.idleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.idleTimer = this.retryTimer = null;
  }
}

export function parseLevels(levels: [string, string][]): Level[] {
  return levels.map(([p, s]) => [Number(p), Number(s)]);
}
