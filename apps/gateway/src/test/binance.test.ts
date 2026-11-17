import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';
import { BinanceVenue } from '../market/binance';
import type { VenueSink } from '../market/venue';
import { createMetrics } from '../metrics';

const depth = (U: number, u: number, pu: number, bid: [string, string]) =>
  JSON.stringify({
    stream: 'btcusdt@depth@100ms',
    data: { e: 'depthUpdate', E: Date.now(), s: 'BTCUSDT', U, u, pu, b: [bid], a: [] },
  });

describe('Binance diff-depth sync', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup(lastUpdateId: number) {
    const metrics = createMetrics();
    const venue = new BinanceVenue({
      log: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test', APP_ENV: 'dev', RELEASE: 't' }),
      metrics,
    });
    const books: { kind: string; bids: [number, number][] }[] = [];
    const sink: VenueSink = {
      onBook: (_s, kind, bids) => books.push({ kind, bids }),
      onTrades: () => {},
      onKline: () => {},
      onConnection: () => {},
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response(
          JSON.stringify({
            lastUpdateId,
            E: Date.now(),
            bids: [['100', '1']],
            asks: [['101', '1']],
          }),
        );
      }),
    );
    // Drive the adapter directly, without a socket.
    const v = venue as unknown as {
      sink: VenueSink;
      resync(s: string, r: string): void;
      handle(raw: string): void;
    };
    v.sink = sink;
    v.resync('BTC-PERP', 'connect');
    const resyncs = async () =>
      (await metrics.upstreamResyncs.get()).values.reduce((n, x) => n + x.value, 0);
    return { v, books, release, resyncs };
  }

  it('replays buffered events that straddle the snapshot, then follows pu/u', async () => {
    const { v, books, release, resyncs } = await setup(7);
    v.handle(depth(1, 5, 0, ['99', '1'])); // older than snapshot → dropped
    v.handle(depth(6, 9, 5, ['98', '2'])); // straddles lastUpdateId=7 → applied
    release();
    await vi.waitFor(() => expect(books[0]?.kind).toBe('snapshot'));
    expect(books.map((b) => b.bids[0]?.[0])).toEqual([100, 98]);

    v.handle(depth(10, 12, 9, ['97', '1'])); // continuous
    expect(books).toHaveLength(3);
    expect(await resyncs()).toBe(1);

    v.handle(depth(15, 18, 14, ['96', '1'])); // pu 14 != 12 → gap
    expect(await resyncs()).toBe(2);
    expect(books).toHaveLength(3);
  });

  it('accepts the first live event after a snapshot newer than the buffer', async () => {
    const { v, books, release, resyncs } = await setup(50);
    v.handle(depth(1, 5, 0, ['99', '1']));
    release();
    await vi.waitFor(() => expect(books[0]?.kind).toBe('snapshot'));
    // pu (40) is older than the snapshot id, but U <= 50 <= u: valid first event.
    v.handle(depth(41, 55, 40, ['98', '1']));
    v.handle(depth(56, 60, 55, ['97', '1']));
    expect(books).toHaveLength(3);
    expect(await resyncs()).toBe(1);
  });
});
