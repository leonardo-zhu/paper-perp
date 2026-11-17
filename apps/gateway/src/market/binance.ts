import { type Candle, MARKETS, type MarketSymbol, SYMBOLS, type TradeDTO } from '@paperperp/shared';
import {
  type FaultKind,
  type MarketVenue,
  parseLevels,
  ReconnectingSocket,
  type VenueDeps,
  type VenueSink,
} from './venue';

// Binance splits USDⓈ-M streams by path: order book on /public, trades and
// klines on /market. The legacy root path now only carries depth.
const WS_PUBLIC = 'wss://fstream.binance.com/public/stream';
const WS_MARKET = 'wss://fstream.binance.com/market/stream';
const REST_BASE = 'https://fapi.binance.com';

interface DepthEvent {
  e: 'depthUpdate';
  E: number;
  U: number;
  u: number;
  pu: number;
  b: [string, string][];
  a: [string, string][];
}

/** Per-symbol diff-depth sync state (Binance USDⓈ-M "manage a local order book"). */
interface SyncState {
  /** Last applied update id (`u`), or null while waiting for a snapshot. */
  lastU: number | null;
  /** True right after the snapshot: the next event must straddle lastUpdateId. */
  awaitingFirst: boolean;
  buffer: DepthEvent[];
  snapshotInFlight: boolean;
}

/**
 * Binance USDⓈ-M futures adapter. Diff-depth stream + REST snapshot:
 *   1. buffer stream events, 2. fetch snapshot (lastUpdateId),
 *   3. drop events with u < lastUpdateId; the first applied event must
 *      straddle it (U <= lastUpdateId <= u). Its `pu` is NOT comparable to
 *      the snapshot id, 4. afterwards every event's `pu` must equal the
 *      previous `u` — otherwise we lost a message and resync from step 1.
 */
export class BinanceVenue implements MarketVenue {
  readonly name = 'binance';
  /** Depth stream: drives book liveness. */
  private socket: ReconnectingSocket;
  /** Trades + klines: best effort, does not affect trading status. */
  private marketSocket: ReconnectingSocket;
  private sink: VenueSink | null = null;
  private sync = new Map<MarketSymbol, SyncState>();
  private bySymbol = new Map<string, MarketSymbol>();
  private dropNextDepth = false;

  constructor(private readonly deps: VenueDeps) {
    const depth: string[] = [];
    const market: string[] = [];
    for (const sym of SYMBOLS) {
      const u = MARKETS[sym].upstream.binance;
      this.bySymbol.set(u.toUpperCase(), sym);
      depth.push(`${u}@depth@100ms`);
      market.push(`${u}@aggTrade`, `${u}@kline_1m`);
    }
    this.socket = new ReconnectingSocket(
      {
        url: `${WS_PUBLIC}?streams=${depth.join('/')}`,
        venue: this.name,
        idleTimeoutMs: 10_000,
        onOpen: () => {
          for (const s of SYMBOLS) this.resync(s, 'connect');
          this.sink?.onConnection(true, null);
        },
        onMessage: (data) => this.handle(data),
        onClose: (reason) => {
          for (const s of SYMBOLS) this.sync.delete(s);
          this.sink?.onConnection(false, reason);
        },
      },
      deps,
    );
    this.marketSocket = new ReconnectingSocket(
      {
        url: `${WS_MARKET}?streams=${market.join('/')}`,
        venue: `${this.name}-market`,
        idleTimeoutMs: 30_000,
        onOpen: () => {},
        onMessage: (data) => this.handle(data),
        onClose: () => {},
      },
      deps,
    );
  }

  start(sink: VenueSink): void {
    this.sink = sink;
    this.socket.start();
    this.marketSocket.start();
  }

  stop(): void {
    this.socket.stop();
    this.marketSocket.stop();
  }

  injectFault(kind: FaultKind, ms = 8_000): void {
    if (kind === 'disconnect') {
      this.socket.drop('fault injection');
      this.marketSocket.drop('fault injection');
    }
    if (kind === 'gap') this.dropNextDepth = true;
    if (kind === 'freeze') {
      this.socket.frozenUntil = Date.now() + ms;
      this.marketSocket.frozenUntil = Date.now() + ms;
    }
  }

  async fetchKlines(symbol: MarketSymbol, limit: number): Promise<Candle[]> {
    const pair = MARKETS[symbol].upstream.binance.toUpperCase();
    const res = await fetch(
      `${REST_BASE}/fapi/v1/klines?symbol=${pair}&interval=1m&limit=${limit}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`binance klines: HTTP ${res.status}`);
    const rows = (await res.json()) as [number, string, string, string, string, string][];
    return rows.map(([t, o, h, l, c, v]) => ({
      t,
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      v: Number(v),
    }));
  }

  private handle(raw: string): void {
    const msg = JSON.parse(raw) as { stream: string; data: Record<string, unknown> };
    const data = msg.data;
    const symbol = this.bySymbol.get(String(data.s));
    if (!symbol || !this.sink) return;
    const now = Date.now();
    if (typeof data.E === 'number') this.deps.metrics.upstreamLag.observe(now - data.E);

    switch (data.e) {
      case 'depthUpdate':
        this.deps.metrics.upstreamMessages.inc({ venue: this.name, kind: 'depth' });
        if (this.dropNextDepth) {
          this.dropNextDepth = false;
          return;
        }
        this.onDepth(symbol, data as unknown as DepthEvent);
        return;
      case 'aggTrade': {
        this.deps.metrics.upstreamMessages.inc({ venue: this.name, kind: 'trade' });
        const trade: TradeDTO = {
          id: String(data.a),
          price: Number(data.p),
          size: Number(data.q),
          // m = buyer is maker → the aggressor sold.
          side: data.m ? 'sell' : 'buy',
          ts: Number(data.T),
        };
        this.sink.onTrades(symbol, [trade]);
        return;
      }
      case 'kline': {
        const k = data.k as Record<string, string | number>;
        this.sink.onKline(symbol, {
          t: Number(k.t),
          o: Number(k.o),
          h: Number(k.h),
          l: Number(k.l),
          c: Number(k.c),
          v: Number(k.v),
        });
        return;
      }
    }
  }

  private onDepth(symbol: MarketSymbol, ev: DepthEvent): void {
    const st = this.sync.get(symbol);
    if (!st) return;
    if (st.lastU === null) {
      st.buffer.push(ev);
      return;
    }
    if (this.ingest(symbol, st, ev) === 'gap') {
      this.deps.log.warn(
        { symbol, lastU: st.lastU, U: ev.U, pu: ev.pu },
        'binance depth gap, resyncing',
      );
      this.resync(symbol, 'gap');
      // Buffer into the fresh sync state so it can be replayed after the snapshot.
      this.sync.get(symbol)?.buffer.push(ev);
    }
  }

  /** Apply one event to a synced book, or report that continuity is broken. */
  private ingest(symbol: MarketSymbol, st: SyncState, ev: DepthEvent): 'ok' | 'gap' {
    const lastU = st.lastU!;
    if (st.awaitingFirst) {
      if (ev.u < lastU) return 'ok'; // fully contained in the snapshot
      if (ev.U > lastU) return 'gap'; // snapshot older than the stream
      st.awaitingFirst = false;
    } else if (ev.pu !== lastU) {
      return 'gap';
    }
    st.lastU = ev.u;
    this.sink?.onBook(symbol, 'delta', parseLevels(ev.b), parseLevels(ev.a), ev.E);
    return 'ok';
  }

  private resync(symbol: MarketSymbol, reason: string): void {
    const prev = this.sync.get(symbol);
    if (prev?.snapshotInFlight) return;
    const st: SyncState = { lastU: null, awaitingFirst: false, buffer: [], snapshotInFlight: true };
    this.sync.set(symbol, st);
    this.deps.metrics.upstreamResyncs.inc({ venue: this.name, reason });
    void this.loadSnapshot(symbol, st);
  }

  private async loadSnapshot(symbol: MarketSymbol, st: SyncState): Promise<void> {
    const pair = MARKETS[symbol].upstream.binance.toUpperCase();
    try {
      const res = await fetch(`${REST_BASE}/fapi/v1/depth?symbol=${pair}&limit=1000`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = (await res.json()) as {
        lastUpdateId: number;
        E: number;
        bids: [string, string][];
        asks: [string, string][];
      };
      if (this.sync.get(symbol) !== st) return; // superseded by a reconnect
      const buffered = st.buffer;
      st.buffer = [];
      st.snapshotInFlight = false;
      st.lastU = snap.lastUpdateId;
      st.awaitingFirst = true;
      this.sink?.onBook(symbol, 'snapshot', parseLevels(snap.bids), parseLevels(snap.asks), snap.E);
      for (const ev of buffered) {
        if (this.ingest(symbol, st, ev) === 'gap') {
          // Usually the snapshot was older than the buffered stream; retry shortly.
          setTimeout(() => this.resync(symbol, 'stale_snapshot'), 500);
          return;
        }
      }
    } catch (err) {
      this.deps.log.warn({ symbol, err: (err as Error).message }, 'binance snapshot failed');
      st.snapshotInFlight = false;
      setTimeout(() => {
        if (this.sync.get(symbol) === st) this.resync(symbol, 'snapshot_error');
      }, 2_000);
    }
  }
}
