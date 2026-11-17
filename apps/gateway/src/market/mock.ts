import {
  type Candle,
  decimalsOf,
  type Level,
  MARKETS,
  type MarketSymbol,
  SYMBOLS,
  type TradeDTO,
} from '@paperperp/shared';
import type { FaultKind, MarketVenue, VenueSink } from './venue';

interface MockOptions {
  /** Starting mid per market; unlisted markets use DEFAULT_START_PRICES. */
  startPrices?: Partial<Record<MarketSymbol, number>>;
  tickMs?: number;
  /** Deterministic runs in tests. */
  random?: () => number;
}

const DEFAULT_START_PRICES: Record<MarketSymbol, number> = {
  'BTC-PERP': 65_000,
  'ETH-PERP': 3_200,
  'SOL-PERP': 150,
};

/** Sizes are scaled so every market's book holds roughly the same notional as BTC's. */
const REFERENCE_PRICE = DEFAULT_START_PRICES['BTC-PERP'];

interface MockMarket {
  mid: number;
  tick: number;
  priceDp: number;
  sizeDp: number;
  /** Distance between generated book levels. */
  levelStep: number;
  /** Size multiplier relative to BTC. */
  sizeScale: number;
  candle: Candle | null;
}

/**
 * Synthetic venue: a random-walk mid per market with a 50-level book on each
 * side. Used for offline development, CI e2e tests and chaos drills — the
 * faults behave like the real adapters (disconnect → reconnect + snapshot).
 */
export class MockVenue implements MarketVenue {
  readonly name = 'mock';
  private sink: VenueSink | null = null;
  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private frozenUntil = 0;
  private tradeId = 0;
  private readonly markets = new Map<MarketSymbol, MockMarket>();
  private readonly random: () => number;
  private readonly tickMs: number;

  constructor(opts: MockOptions = {}) {
    this.tickMs = opts.tickMs ?? 100;
    this.random = opts.random ?? Math.random;
    for (const s of SYMBOLS) {
      const cfg = MARKETS[s];
      const mid = opts.startPrices?.[s] ?? DEFAULT_START_PRICES[s];
      const tick = Number(cfg.tickSize);
      this.markets.set(s, {
        mid,
        tick,
        priceDp: decimalsOf(cfg.tickSize),
        sizeDp: decimalsOf(cfg.stepSize),
        // ~0.5 on BTC at 65k; never finer than one tick.
        levelStep: Math.max(tick, Math.round((mid * 7.7e-6) / tick) * tick),
        sizeScale: REFERENCE_PRICE / mid,
        candle: null,
      });
    }
  }

  start(sink: VenueSink): void {
    this.sink = sink;
    this.connect();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
  }

  injectFault(kind: FaultKind, ms = 8_000): void {
    if (kind === 'disconnect') {
      this.stop();
      this.sink?.onConnection(false, 'fault injection');
      setTimeout(() => this.connect(), 2_000);
    } else {
      // A gap cannot happen on a snapshot-healing feed; model both as silence.
      this.frozenUntil = Date.now() + ms;
    }
  }

  async fetchKlines(symbol: MarketSymbol, limit: number): Promise<Candle[]> {
    const m = this.m(symbol);
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const out: Candle[] = [];
    let price = m.mid * (1 - 0.0004 * limit * 0.05);
    for (let i = limit - 1; i >= 1; i--) {
      const o = price;
      const c = o * (1 + (this.random() - 0.48) * 0.002);
      out.push({
        t: now - i * 60_000,
        o,
        c,
        h: Math.max(o, c) * (1 + this.random() * 0.0008),
        l: Math.min(o, c) * (1 - this.random() * 0.0008),
        v: (5 + this.random() * 50) * m.sizeScale,
      });
      price = c;
    }
    m.mid = price;
    return out;
  }

  private m(symbol: MarketSymbol): MockMarket {
    return this.markets.get(symbol)!;
  }

  private connect(): void {
    this.connected = true;
    this.sink?.onConnection(true, null);
    for (const s of SYMBOLS) {
      const { bids, asks } = this.levels(this.m(s));
      this.sink?.onBook(s, 'snapshot', bids, asks, Date.now());
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  private levels(m: MockMarket): { bids: Level[]; asks: Level[] } {
    const best = roundTo(m.mid, m.priceDp);
    const bids: Level[] = [];
    const asks: Level[] = [];
    for (let i = 0; i < 50; i++) {
      const offset = m.tick + i * m.levelStep;
      bids.push([roundTo(best - offset, m.priceDp), this.size(m, 0.05, 3)]);
      asks.push([roundTo(best + offset, m.priceDp), this.size(m, 0.05, 3)]);
    }
    return { bids, asks };
  }

  /** Random size in [min, min + span) BTC-equivalent, on the market's step. */
  private size(m: MockMarket, min: number, span: number): number {
    const raw = (min + this.random() * span) * m.sizeScale;
    return Math.max(roundTo(raw, m.sizeDp), 10 ** -m.sizeDp);
  }

  private tick(): void {
    if (!this.connected || !this.sink || Date.now() < this.frozenUntil) return;
    const now = Date.now();
    for (const s of SYMBOLS) {
      const m = this.m(s);
      m.mid *= 1 + (this.random() - 0.5) * 0.0004;
      // Re-centre the whole ladder on the new mid. Sending the full ladder as a
      // snapshot keeps the mock simple; the gateway diffs it into deltas.
      const { bids, asks } = this.levels(m);
      this.sink.onBook(s, 'snapshot', bids, asks, now);
      if (this.random() < 0.6) {
        const trade: TradeDTO = {
          id: String(++this.tradeId),
          price: roundTo(m.mid, m.priceDp),
          size: this.size(m, 0.001, 0.5),
          side: this.random() < 0.5 ? 'buy' : 'sell',
          ts: now,
        };
        this.sink.onTrades(s, [trade]);
        this.updateCandle(s, m, trade);
      }
    }
  }

  private updateCandle(symbol: MarketSymbol, m: MockMarket, trade: TradeDTO): void {
    const t = Math.floor(trade.ts / 60_000) * 60_000;
    const p = trade.price;
    if (!m.candle || m.candle.t !== t) m.candle = { t, o: p, h: p, l: p, c: p, v: 0 };
    const c = m.candle;
    c.h = Math.max(c.h, p);
    c.l = Math.min(c.l, p);
    c.c = p;
    c.v += trade.size;
    this.sink?.onKline(symbol, { ...c });
  }
}

function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
