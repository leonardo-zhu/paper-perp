import { type Candle, MARKETS, type MarketSymbol, SYMBOLS } from '@paperperp/shared';
import {
  type FaultKind,
  type MarketVenue,
  ReconnectingSocket,
  type VenueDeps,
  type VenueSink,
} from './venue';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const INFO_URL = 'https://api.hyperliquid.xyz/info';

type HlLevel = { px: string; sz: string; n: number };

/**
 * Hyperliquid adapter. `l2Book` pushes full top-20 snapshots, so there is no
 * sequence to track here; the gateway's own diffing turns them into deltas.
 */
export class HyperliquidVenue implements MarketVenue {
  readonly name = 'hyperliquid';
  private socket: ReconnectingSocket;
  private sink: VenueSink | null = null;
  private byCoin = new Map<string, MarketSymbol>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: VenueDeps) {
    for (const s of SYMBOLS) this.byCoin.set(MARKETS[s].upstream.hyperliquid, s);
    this.socket = new ReconnectingSocket(
      {
        url: WS_URL,
        venue: this.name,
        idleTimeoutMs: 20_000,
        onOpen: () => {
          for (const coin of this.byCoin.keys()) {
            for (const subscription of [
              { type: 'l2Book', coin },
              { type: 'trades', coin },
              { type: 'candle', coin, interval: '1m' },
            ]) {
              this.socket.send({ method: 'subscribe', subscription });
            }
          }
          this.sink?.onConnection(true, null);
        },
        onMessage: (data) => this.handle(data),
        onClose: (reason) => this.sink?.onConnection(false, reason),
      },
      deps,
    );
  }

  start(sink: VenueSink): void {
    this.sink = sink;
    this.socket.start();
    // Hyperliquid closes connections that send nothing for 60s.
    this.pingTimer = setInterval(() => this.socket.send({ method: 'ping' }), 30_000);
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket.stop();
  }

  injectFault(kind: FaultKind, ms = 8_000): void {
    if (kind === 'disconnect') this.socket.drop('fault injection');
    // Snapshots-only feed: a lost message is healed by the next snapshot.
    if (kind === 'freeze' || kind === 'gap') this.socket.frozenUntil = Date.now() + ms;
  }

  async fetchKlines(symbol: MarketSymbol, limit: number): Promise<Candle[]> {
    const endTime = Date.now();
    const res = await fetch(INFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: {
          coin: MARKETS[symbol].upstream.hyperliquid,
          interval: '1m',
          startTime: endTime - limit * 60_000,
          endTime,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`hyperliquid candles: HTTP ${res.status}`);
    const rows = (await res.json()) as Record<string, string | number>[];
    return rows.map(toCandle);
  }

  private handle(raw: string): void {
    const msg = JSON.parse(raw) as { channel: string; data: unknown };
    if (!this.sink) return;
    if (msg.channel === 'l2Book') {
      const d = msg.data as { coin: string; time: number; levels: [HlLevel[], HlLevel[]] };
      const symbol = this.byCoin.get(d.coin);
      if (!symbol) return;
      this.deps.metrics.upstreamMessages.inc({ venue: this.name, kind: 'depth' });
      this.deps.metrics.upstreamLag.observe(Date.now() - d.time);
      const side = (ls: HlLevel[]) =>
        ls.map((l) => [Number(l.px), Number(l.sz)] as [number, number]);
      this.sink.onBook(symbol, 'snapshot', side(d.levels[0]), side(d.levels[1]), d.time);
    } else if (msg.channel === 'trades') {
      const trades = msg.data as {
        coin: string;
        side: 'A' | 'B';
        px: string;
        sz: string;
        time: number;
        tid: number;
      }[];
      const symbol = trades[0] && this.byCoin.get(trades[0].coin);
      if (!symbol) return;
      this.deps.metrics.upstreamMessages.inc({ venue: this.name, kind: 'trade' });
      this.sink.onTrades(
        symbol,
        trades.map((t) => ({
          id: String(t.tid),
          price: Number(t.px),
          size: Number(t.sz),
          side: t.side === 'B' ? 'buy' : 'sell',
          ts: t.time,
        })),
      );
    } else if (msg.channel === 'candle') {
      const c = msg.data as Record<string, string | number>;
      const symbol = this.byCoin.get(String(c.s));
      if (symbol) this.sink.onKline(symbol, toCandle(c));
    }
  }
}

function toCandle(c: Record<string, string | number>): Candle {
  return {
    t: Number(c.t),
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
    v: Number(c.v),
  };
}
