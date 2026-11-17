import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketFeed, markOf, useMarket } from './market';

const snapshot = (seq: number, epoch = 'e1') => ({
  type: 'book.snapshot' as const,
  symbol: 'BTC-PERP',
  epoch,
  seq,
  bids: [[100, 1]] as [number, number][],
  asks: [[101, 1]] as [number, number][],
  ts: Date.now(),
});
const delta = (prevSeq: number, seq: number, epoch = 'e1') => ({
  type: 'book.delta' as const,
  symbol: 'BTC-PERP',
  epoch,
  prevSeq,
  seq,
  bids: [[99, 2]] as [number, number][],
  asks: [] as [number, number][],
  ts: Date.now(),
});

describe('market feed mirror', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies consecutive deltas and publishes the top of book', () => {
    marketFeed._inject(snapshot(10));
    marketFeed._inject(delta(10, 11));
    marketFeed._flushNow();
    const s = useMarket.getState();
    expect(s.seq).toBe(11);
    expect(s.book.bids).toEqual([
      [100, 1],
      [99, 2],
    ]);
    expect(s.mid).toBe(100.5);
  });

  it('requests a resync on a sequence gap and ignores deltas until the snapshot', () => {
    marketFeed._inject(snapshot(20));
    const before = useMarket.getState().resyncs;
    marketFeed._inject(delta(25, 26));
    expect(useMarket.getState().resyncs).toBe(before + 1);
    marketFeed._inject(delta(20, 21)); // ignored while resync is pending
    marketFeed._flushNow();
    expect(useMarket.getState().seq).toBe(20);
    marketFeed._inject(snapshot(30));
    marketFeed._inject(delta(30, 31));
    marketFeed._flushNow();
    expect(useMarket.getState().seq).toBe(31);
  });

  it('treats a new gateway epoch as a gap (gateway restarted)', () => {
    marketFeed._inject(snapshot(5, 'old'));
    const before = useMarket.getState().resyncs;
    marketFeed._inject(delta(5, 6, 'new'));
    expect(useMarket.getState().resyncs).toBe(before + 1);
  });

  it('drops the old market on switch and ignores its late messages', () => {
    marketFeed._inject(snapshot(40));
    marketFeed._flushNow();
    expect(useMarket.getState().mid).toBe(100.5);

    marketFeed.setSymbol('ETH-PERP');
    let s = useMarket.getState();
    expect(s.symbol).toBe('ETH-PERP');
    expect(s.mid).toBeUndefined();
    expect(s.book.bids).toEqual([]);
    expect(s.status).toBe('reconnecting');

    // A BTC delta still in flight must not touch the ETH mirror or trigger a resync.
    const resyncs = s.resyncs;
    marketFeed._inject(delta(40, 41));
    marketFeed._inject({
      ...snapshot(1),
      symbol: 'ETH-PERP',
      bids: [[3_000, 1]],
      asks: [[3_001, 1]],
    });
    marketFeed._flushNow();
    s = useMarket.getState();
    expect(s.resyncs).toBe(resyncs);
    expect(s.mid).toBe(3_000.5);

    marketFeed.setSymbol('BTC-PERP');
  });

  it('marks other markets from the tickers channel', () => {
    marketFeed._inject({
      type: 'tickers',
      tickers: [
        { symbol: 'BTC-PERP', mid: 65_000, status: 'live' },
        { symbol: 'SOL-PERP', mid: 151.25, status: 'live' },
      ],
    });
    const s = useMarket.getState();
    expect(markOf(s, 'SOL-PERP')).toBe(151.25);
    // The viewed market uses its own live mirror, not the once-a-second ticker.
    expect(markOf(s, s.symbol)).toBe(s.mid);
    expect(markOf(s, 'ETH-PERP')).toBeUndefined();
  });
});
