import {
  BOOK_PUBLISH_INTERVAL_MS,
  decimalsOf,
  MARKETS,
  OrderBook,
  type ServerMessage,
  SYMBOLS,
  TICKER_INTERVAL_MS,
} from '@paperperp/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';
import { MarketService } from '../market/market-service';
import { MockVenue } from '../market/mock';
import type { MarketVenue, VenueSink } from '../market/venue';
import { createMetrics } from '../metrics';
import { applyFill, planFills } from '../trading/matching';

describe('position accounting', () => {
  it('averages entry when adding and realises PnL when reducing', () => {
    let p = { size: 0, entryPrice: 0, realizedPnl: 0 };
    p = applyFill(p, 'buy', 1, 100, 3);
    p = applyFill(p, 'buy', 1, 110, 3);
    expect(p.entryPrice).toBe(105);
    const r = applyFill(p, 'sell', 0.5, 115, 3);
    expect(r.realized).toBe(5);
    expect(r.size).toBe(1.5);
    expect(r.entryPrice).toBe(105);
  });

  it('flips sides and opens the remainder at the fill price', () => {
    const r = applyFill({ size: 1, entryPrice: 100, realizedPnl: 0 }, 'sell', 3, 90, 3);
    expect(r.realized).toBe(-10);
    expect(r.size).toBe(-2);
    expect(r.entryPrice).toBe(90);
  });
});

describe('planFills', () => {
  it('only takes levels within the limit, best first', () => {
    const book = new OrderBook();
    book.applySnapshot(
      0,
      [],
      [
        [101, 1],
        [100, 0.4],
        [103, 5],
      ],
    );
    expect(planFills(book, 'buy', 101, 2, 3)).toEqual([
      { price: 100, size: 0.4 },
      { price: 101, size: 1 },
    ]);
  });
});

class FakeVenue implements MarketVenue {
  readonly name = 'fake';
  sink!: VenueSink;
  start(sink: VenueSink) {
    this.sink = sink;
  }
  stop() {}
  async fetchKlines() {
    return [];
  }
  injectFault() {}
}

describe('MarketService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const venue = new FakeVenue();
    const sent: { channel: string; msg: ServerMessage }[] = [];
    const svc = new MarketService(
      venue,
      {
        log: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test', APP_ENV: 'dev', RELEASE: 't' }),
        metrics: createMetrics(),
        staleAfterMs: 2_000,
      },
      { publish: (channel, msg) => sent.push({ channel, msg }) },
    );
    await svc.start();
    return { venue, svc, sent };
  }

  it('coalesces upstream updates into consecutive sequenced deltas', async () => {
    const { venue, svc, sent } = await setup();
    venue.sink.onConnection(true, null);
    venue.sink.onBook('BTC-PERP', 'snapshot', [[100, 1]], [[101, 1]], Date.now());
    venue.sink.onBook('BTC-PERP', 'delta', [[100, 2]], [], Date.now());
    venue.sink.onBook('BTC-PERP', 'delta', [[99, 1]], [], Date.now());
    vi.advanceTimersByTime(BOOK_PUBLISH_INTERVAL_MS);
    venue.sink.onBook('BTC-PERP', 'delta', [[100, 0]], [], Date.now());
    vi.advanceTimersByTime(BOOK_PUBLISH_INTERVAL_MS);

    const deltas = sent.filter((s) => s.msg.type === 'book.delta').map((s) => s.msg);
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => d.type === 'book.delta' && [d.prevSeq, d.seq])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    // A client replaying snapshot(seq 0) + deltas ends up with the gateway view.
    const mirror = new OrderBook();
    mirror.applySnapshot(0, [], []);
    for (const d of deltas)
      if (d.type === 'book.delta') mirror.applyDelta(d.prevSeq, d.seq, d.bids, d.asks);
    const snap = svc.snapshotMessage('BTC-PERP');
    expect(snap.type === 'book.snapshot' && mirror.top(25)).toEqual(
      snap.type === 'book.snapshot' && { bids: snap.bids, asks: snap.asks },
    );
    svc.stop();
  });

  it('goes stale when the venue goes quiet and recovers on new data', async () => {
    const { venue, svc } = await setup();
    venue.sink.onConnection(true, null);
    venue.sink.onBook('BTC-PERP', 'snapshot', [[100, 1]], [[101, 1]], Date.now());
    expect(svc.status('BTC-PERP')).toBe('live');
    vi.advanceTimersByTime(2_500);
    expect(svc.status('BTC-PERP')).toBe('stale');
    venue.sink.onBook('BTC-PERP', 'delta', [[100, 3]], [], Date.now());
    expect(svc.status('BTC-PERP')).toBe('live');
    venue.sink.onConnection(false, 'closed');
    expect(svc.status('BTC-PERP')).toBe('reconnecting');
    svc.stop();
  });

  it("publishes every market's mid and status on the tickers channel", async () => {
    const { venue, svc, sent } = await setup();
    venue.sink.onConnection(true, null);
    venue.sink.onBook('ETH-PERP', 'snapshot', [[3_000, 1]], [[3_000.02, 1]], Date.now());
    vi.advanceTimersByTime(TICKER_INTERVAL_MS);

    const last = sent.filter((s) => s.channel === 'tickers').at(-1)?.msg;
    expect(last?.type).toBe('tickers');
    const tickers = last?.type === 'tickers' ? last.tickers : [];
    expect(tickers.map((t) => t.symbol)).toEqual(SYMBOLS);
    expect(tickers.find((t) => t.symbol === 'ETH-PERP')).toMatchObject({
      mid: 3_000.01,
      status: 'live',
    });
    expect(tickers.find((t) => t.symbol === 'BTC-PERP')).toMatchObject({
      mid: null,
      status: 'reconnecting',
    });
    svc.stop();
  });
});

describe('MockVenue', () => {
  it('walks each market around its own price on its own tick', () => {
    const books = new Map<string, { bids: [number, number][]; asks: [number, number][] }>();
    const venue = new MockVenue({ tickMs: 1_000_000 });
    venue.start({
      onBook: (symbol, _kind, bids, asks) => books.set(symbol, { bids, asks }),
      onTrades: () => {},
      onKline: () => {},
      onConnection: () => {},
    });
    venue.stop();

    const mids = Object.fromEntries(
      SYMBOLS.map((s) => {
        const b = books.get(s)!;
        return [s, (b.bids[0]![0] + b.asks[0]![0]) / 2];
      }),
    );
    expect(mids['BTC-PERP']).toBeCloseTo(65_000, -1);
    expect(mids['ETH-PERP']).toBeCloseTo(3_200, 0);
    expect(mids['SOL-PERP']).toBeCloseTo(150, 0);

    for (const s of SYMBOLS) {
      const { bids, asks } = books.get(s)!;
      const pdp = decimalsOf(MARKETS[s].tickSize);
      const sdp = decimalsOf(MARKETS[s].stepSize);
      for (const [p, size] of [...bids, ...asks]) {
        expect(Number(p.toFixed(pdp))).toBe(p);
        expect(Number(size.toFixed(sdp))).toBe(size);
        expect(size).toBeGreaterThan(0);
      }
      expect(bids[0]![0]).toBeLessThan(asks[0]![0]);
    }
  });
});
