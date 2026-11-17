import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketFeed, useMarket } from './market';

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
});
