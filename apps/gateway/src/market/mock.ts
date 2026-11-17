import {
  type Candle,
  type Level,
  type MarketSymbol,
  SYMBOLS,
  type TradeDTO,
} from '@paperperp/shared';
import type { FaultKind, MarketVenue, VenueSink } from './venue';

interface MockOptions {
  startPrice?: number;
  tickMs?: number;
  /** Deterministic runs in tests. */
  random?: () => number;
}

/**
 * Synthetic venue: a random-walk mid with a 50-level book on each side.
 * Used for offline development, CI e2e tests and chaos drills — the faults
 * behave like the real adapters (disconnect → reconnect + snapshot).
 */
export class MockVenue implements MarketVenue {
  readonly name = 'mock';
  private sink: VenueSink | null = null;
  private timer: NodeJS.Timeout | null = null;
  private mid: number;
  private connected = false;
  private frozenUntil = 0;
  private tradeId = 0;
  private candle: Candle | null = null;
  private readonly random: () => number;
  private readonly tickMs: number;

  constructor(opts: MockOptions = {}) {
    this.mid = opts.startPrice ?? 65_000;
    this.tickMs = opts.tickMs ?? 100;
    this.random = opts.random ?? Math.random;
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

  async fetchKlines(_symbol: MarketSymbol, limit: number): Promise<Candle[]> {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const out: Candle[] = [];
    let price = this.mid * (1 - 0.0004 * limit * 0.05);
    for (let i = limit - 1; i >= 1; i--) {
      const o = price;
      const c = o * (1 + (this.random() - 0.48) * 0.002);
      out.push({
        t: now - i * 60_000,
        o,
        c,
        h: Math.max(o, c) * (1 + this.random() * 0.0008),
        l: Math.min(o, c) * (1 - this.random() * 0.0008),
        v: 5 + this.random() * 50,
      });
      price = c;
    }
    this.mid = price;
    return out;
  }

  private connect(): void {
    this.connected = true;
    this.sink?.onConnection(true, null);
    for (const s of SYMBOLS) {
      const { bids, asks } = this.levels();
      this.sink?.onBook(s, 'snapshot', bids, asks, Date.now());
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  private levels(): { bids: Level[]; asks: Level[] } {
    const best = Math.round(this.mid * 10) / 10;
    const bids: Level[] = [];
    const asks: Level[] = [];
    for (let i = 0; i < 50; i++) {
      bids.push([round1(best - 0.1 - i * 0.5), round3(0.05 + this.random() * 3)]);
      asks.push([round1(best + 0.1 + i * 0.5), round3(0.05 + this.random() * 3)]);
    }
    return { bids, asks };
  }

  private tick(): void {
    if (!this.connected || !this.sink || Date.now() < this.frozenUntil) return;
    const now = Date.now();
    this.mid *= 1 + (this.random() - 0.5) * 0.0004;
    // Re-centre the whole ladder on the new mid. Sending the full ladder as a
    // snapshot keeps the mock simple; the gateway diffs it into deltas.
    const { bids, asks } = this.levels();
    for (const s of SYMBOLS) {
      this.sink.onBook(s, 'snapshot', bids, asks, now);
      if (this.random() < 0.6) {
        const trade: TradeDTO = {
          id: String(++this.tradeId),
          price: round1(this.mid),
          size: round3(0.001 + this.random() * 0.5),
          side: this.random() < 0.5 ? 'buy' : 'sell',
          ts: now,
        };
        this.sink.onTrades(s, [trade]);
        this.updateCandle(s, trade);
      }
    }
  }

  private updateCandle(symbol: MarketSymbol, trade: TradeDTO): void {
    const t = Math.floor(trade.ts / 60_000) * 60_000;
    const p = trade.price;
    if (!this.candle || this.candle.t !== t) this.candle = { t, o: p, h: p, l: p, c: p, v: 0 };
    const c = this.candle;
    c.h = Math.max(c.h, p);
    c.l = Math.min(c.l, p);
    c.c = p;
    c.v += trade.size;
    this.sink?.onKline(symbol, { ...c });
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
