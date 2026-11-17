import { type Candle, MARKETS, type MarketSymbol, SYMBOLS, type TradeDTO } from '@paperperp/shared';
import {
  type FaultKind,
  type MarketVenue,
  parseLevels,
  ReconnectingSocket,
  type VenueDeps,
  type VenueSink,
} from './venue';

const WS_BASE = 'wss://fstream.binance.com/stream';
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
  buffer: DepthEvent[];
  snapshotInFlight: boolean;
}

/**
 * Binance USDⓈ-M futures adapter. Diff-depth stream + REST snapshot:
 *   1. buffer stream events, 2. fetch snapshot (lastUpdateId),
 *   3. drop events with u < lastUpdateId, the first applied event must
 *      straddle lastUpdateId, 4. afterwards every event's `pu` must equal the
 *      previous `u` — otherwise we lost a message and resync from step 1.
 */
export class BinanceVenue implements MarketVenue {
  readonly name = 'binance';
  private socket: ReconnectingSocket;
  private sink: VenueSink | null = null;
  private sync = new Map<MarketSymbol, SyncState>();
  private bySymbol = new Map<string, MarketSymbol>();
  private dropNextDepth = false;

  constructor(private readonly deps: VenueDeps) {
    const streams = SYMBOLS.flatMap((s) => {
      const u = MARKETS[s].upstream.binance;
      this.bySymbol.set(u.toUpperCase(), s);
      return [`${u}@depth@100ms`, `${u}@aggTrade`, `${u}@kline_1m`];
    });
    this.socket = new ReconnectingSocket(
      {
        url: `${WS_BASE}?streams=${streams.join('/')}`,
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
  }

  start(sink: VenueSink): void {
    this.sink = sink;
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
  }

  injectFault(kind: FaultKind, ms = 8_000): void {
    if (kind === 'disconnect') this.socket.drop('fault injection');
    if (kind === 'gap') this.dropNextDepth = true;
    if (kind === 'freeze') this.socket.frozenUntil = Date.now() + ms;
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
    if (ev.pu !== st.lastU) {
      this.deps.log.warn({ symbol, expected: st.lastU, pu: ev.pu }, 'binance depth gap, resyncing');
      this.resync(symbol, 'gap');
      // Buffer into the fresh sync state so it can be replayed after the snapshot.
      this.sync.get(symbol)?.buffer.push(ev);
      return;
    }
    this.applyEvent(symbol, st, ev);
  }

  private applyEvent(symbol: MarketSymbol, st: SyncState, ev: DepthEvent): void {
    st.lastU = ev.u;
    this.sink?.onBook(symbol, 'delta', parseLevels(ev.b), parseLevels(ev.a), ev.E);
  }

  private resync(symbol: MarketSymbol, reason: string): void {
    const prev = this.sync.get(symbol);
    if (prev?.snapshotInFlight) return;
    const st: SyncState = { lastU: null, buffer: [], snapshotInFlight: true };
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
      const pending = st.buffer.filter((e) => e.u >= snap.lastUpdateId);
      const first = pending[0];
      if (first && first.U > snap.lastUpdateId) {
        // Snapshot is older than the stream we buffered; try again.
        st.snapshotInFlight = false;
        setTimeout(() => this.resync(symbol, 'stale_snapshot'), 500);
        return;
      }
      st.buffer = [];
      st.snapshotInFlight = false;
      st.lastU = snap.lastUpdateId;
      this.sink?.onBook(symbol, 'snapshot', parseLevels(snap.bids), parseLevels(snap.asks), snap.E);
      for (const [i, ev] of pending.entries()) {
        if (i > 0 && ev.pu !== st.lastU) return this.resync(symbol, 'gap');
        this.applyEvent(symbol, st, ev);
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
