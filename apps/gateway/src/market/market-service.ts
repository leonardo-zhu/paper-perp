import { randomUUID } from 'node:crypto';
import {
  BOOK_DEPTH,
  BOOK_PUBLISH_INTERVAL_MS,
  type BookView,
  type Candle,
  channels,
  diffViews,
  type Level,
  type MarketStatus,
  type MarketSymbol,
  OrderBook,
  type ServerMessage,
  SYMBOLS,
  type TradeDTO,
} from '@paperperp/shared';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { FaultKind, MarketVenue, VenueSink } from './venue';

export interface Publisher {
  publish(channel: string, msg: ServerMessage): void;
}

const MAX_TRADES = 50;
const MAX_CANDLES = 500;

interface SymbolState {
  /** Full upstream book, used for matching. */
  book: OrderBook;
  /** Top-N view last sent to clients; deltas are diffs against this. */
  published: BookView;
  seq: number;
  dirty: boolean;
  /** Set after the first book message following a (re)connect. */
  hasData: boolean;
  lastUpstreamAt: number;
  status: MarketStatus;
  statusReason: string | null;
  statusSince: number;
  trades: TradeDTO[];
  pendingTrades: TradeDTO[];
  candles: Candle[];
  pendingCandle: Candle | null;
}

/**
 * Turns a venue feed into the gateway's own sequenced stream:
 *  - coalesces upstream updates and publishes at most one delta per
 *    BOOK_PUBLISH_INTERVAL_MS (bounded fan-out cost regardless of venue rate)
 *  - owns sequence numbers, so clients never depend on venue-specific ids
 *  - tracks liveness: reconnecting → live → stale
 */
export class MarketService {
  readonly epoch = randomUUID().slice(0, 8);
  private readonly state = new Map<MarketSymbol, SymbolState>();
  private connected = false;
  private connectionReason: string | null = 'starting';
  private timers: NodeJS.Timeout[] = [];
  /** Called after each published book change (the engine matches resting orders here). */
  onBookChange: ((symbol: MarketSymbol) => void) | null = null;

  constructor(
    private readonly venue: MarketVenue,
    private readonly deps: { log: Logger; metrics: Metrics; staleAfterMs: number },
    private readonly publisher: Publisher,
  ) {
    const now = Date.now();
    for (const s of SYMBOLS) {
      this.state.set(s, {
        book: new OrderBook(),
        published: { bids: [], asks: [] },
        seq: 0,
        dirty: false,
        hasData: false,
        lastUpstreamAt: 0,
        status: 'reconnecting',
        statusReason: 'starting',
        statusSince: now,
        trades: [],
        pendingTrades: [],
        candles: [],
        pendingCandle: null,
      });
    }
  }

  get venueName(): string {
    return this.venue.name;
  }

  async start(): Promise<void> {
    await Promise.all(
      SYMBOLS.map(async (s) => {
        try {
          this.st(s).candles = await this.venue.fetchKlines(s, MAX_CANDLES);
        } catch (err) {
          this.deps.log.warn({ symbol: s, err: (err as Error).message }, 'kline history failed');
        }
      }),
    );
    this.venue.start(this.sink);
    this.timers.push(setInterval(() => this.flush(), BOOK_PUBLISH_INTERVAL_MS));
    this.timers.push(setInterval(() => this.checkStatus(), 250));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.venue.stop();
  }

  injectFault(kind: FaultKind, ms?: number): void {
    this.deps.log.warn({ kind, ms }, 'fault injected');
    this.venue.injectFault(kind, ms);
  }

  // ---- queries ----

  status(symbol: MarketSymbol): MarketStatus {
    return this.st(symbol).status;
  }

  book(symbol: MarketSymbol): OrderBook {
    return this.st(symbol).book;
  }

  mid(symbol: MarketSymbol): number | undefined {
    return this.st(symbol).book.mid();
  }

  candles(symbol: MarketSymbol): Candle[] {
    return this.st(symbol).candles;
  }

  snapshotMessage(symbol: MarketSymbol): ServerMessage {
    const st = this.st(symbol);
    return {
      type: 'book.snapshot',
      symbol,
      epoch: this.epoch,
      seq: st.seq,
      bids: st.published.bids,
      asks: st.published.asks,
      ts: Date.now(),
    };
  }

  statusMessage(symbol: MarketSymbol): ServerMessage {
    const st = this.st(symbol);
    return {
      type: 'market.status',
      symbol,
      status: st.status,
      reason: st.statusReason,
      since: st.statusSince,
    };
  }

  tradesMessage(symbol: MarketSymbol): ServerMessage {
    return { type: 'trades', symbol, trades: this.st(symbol).trades, snapshot: true };
  }

  // ---- venue callbacks ----

  private readonly sink: VenueSink = {
    onBook: (symbol, kind, bids, asks) => {
      const st = this.st(symbol);
      if (kind === 'snapshot') st.book.applySnapshot(0, bids, asks);
      else st.book.applyLevels(bids, asks);
      st.dirty = true;
      st.hasData = true;
      st.lastUpstreamAt = Date.now();
      this.evaluate(symbol);
    },
    onTrades: (symbol, trades) => {
      const st = this.st(symbol);
      st.pendingTrades.push(...trades);
      st.trades = [...trades.toReversed(), ...st.trades].slice(0, MAX_TRADES);
    },
    onKline: (symbol, candle) => {
      const st = this.st(symbol);
      const last = st.candles.at(-1);
      if (last && last.t === candle.t) st.candles[st.candles.length - 1] = candle;
      else if (!last || candle.t > last.t) {
        st.candles.push(candle);
        if (st.candles.length > MAX_CANDLES) st.candles.shift();
      }
      st.pendingCandle = candle;
    },
    onConnection: (connected, reason) => {
      this.connected = connected;
      this.connectionReason = reason;
      for (const s of SYMBOLS) {
        if (!connected) this.st(s).hasData = false;
        this.evaluate(s);
      }
    },
  };

  // ---- internals ----

  private st(symbol: MarketSymbol): SymbolState {
    return this.state.get(symbol)!;
  }

  private flush(): void {
    for (const symbol of SYMBOLS) {
      const st = this.st(symbol);
      if (st.dirty) {
        st.dirty = false;
        const view = st.book.top(BOOK_DEPTH);
        const delta = diffViews(st.published, view);
        if (delta.bids.length || delta.asks.length) {
          const prevSeq = st.seq;
          st.seq += 1;
          st.published = view;
          this.deps.metrics.bookSeq.set({ symbol }, st.seq);
          this.publisher.publish(channels.book(symbol), {
            type: 'book.delta',
            symbol,
            epoch: this.epoch,
            prevSeq,
            seq: st.seq,
            bids: delta.bids as Level[],
            asks: delta.asks as Level[],
            ts: Date.now(),
          });
          this.onBookChange?.(symbol);
        }
      }
      if (st.pendingTrades.length) {
        this.publisher.publish(channels.trades(symbol), {
          type: 'trades',
          symbol,
          trades: st.pendingTrades,
          snapshot: false,
        });
        st.pendingTrades = [];
      }
      if (st.pendingCandle) {
        this.publisher.publish(channels.kline(symbol), {
          type: 'kline',
          symbol,
          interval: '1m',
          candle: st.pendingCandle,
        });
        st.pendingCandle = null;
      }
    }
  }

  private checkStatus(): void {
    for (const s of SYMBOLS) this.evaluate(s);
  }

  private evaluate(symbol: MarketSymbol): void {
    const st = this.st(symbol);
    const now = Date.now();
    let status: MarketStatus;
    let reason: string | null = null;
    if (!this.connected || !st.hasData) {
      status = 'reconnecting';
      reason = this.connected ? 'waiting for snapshot' : (this.connectionReason ?? 'disconnected');
    } else if (now - st.lastUpstreamAt > this.deps.staleAfterMs) {
      status = 'stale';
      reason = `no market data for ${Math.round((now - st.lastUpstreamAt) / 1000)}s`;
    } else {
      status = 'live';
    }
    if (status === st.status) return;
    this.deps.log.info({ symbol, from: st.status, to: status, reason }, 'market status changed');
    st.status = status;
    st.statusReason = reason;
    st.statusSince = now;
    this.deps.metrics.marketLive.set({ symbol }, status === 'live' ? 1 : 0);
    this.publisher.publish(channels.book(symbol), this.statusMessage(symbol));
  }
}
