import {
  BOOK_DEPTH,
  type BookView,
  type Candle,
  channels,
  DEFAULT_SYMBOL,
  isMarketSymbol,
  type MarketStatus,
  type MarketSymbol,
  OrderBook,
  type ServerMessage,
  type Ticker,
  type TradeDTO,
} from '@paperperp/shared';
import { create } from 'zustand';
import { wsUrl } from '../config';
import { ReconnectingSocket, type SocketState } from '../lib/socket';

const SYMBOL_KEY = 'paperperp.market';

/** Last market the viewer picked; storage can be unavailable (private mode, previews). */
function initialSymbol(): MarketSymbol {
  try {
    const saved = localStorage.getItem(SYMBOL_KEY);
    if (saved && isMarketSymbol(saved)) return saved;
  } catch {}
  return DEFAULT_SYMBOL;
}

export interface MarketState {
  /** Market the terminal is showing; book, trades, candle and status belong to it. */
  symbol: MarketSymbol;
  /** Mid and status of every market, refreshed about once a second. */
  tickers: Partial<Record<MarketSymbol, Ticker>>;
  socket: SocketState;
  rttMs: number | null;
  status: MarketStatus;
  statusReason: string | null;
  book: BookView;
  seq: number;
  mid: number | undefined;
  trades: TradeDTO[];
  candle: Candle | null;
  /** How many times the client had to resync the book (gaps, restarts). */
  resyncs: number;
  /** True once the socket confirmed our session for the private channel. */
  authenticated: boolean;
}

export const useMarket = create<MarketState>(() => ({
  symbol: initialSymbol(),
  tickers: {},
  socket: 'closed',
  rttMs: null,
  status: 'reconnecting',
  statusReason: 'connecting',
  book: { bids: [], asks: [] },
  seq: -1,
  mid: undefined,
  trades: [],
  candle: null,
  resyncs: 0,
  authenticated: false,
}));

type PrivateMessage = Extract<ServerMessage, { type: 'order' | 'fill' | 'position' | 'account' }>;

/**
 * Owns the WebSocket and a local mirror of the gateway order book.
 *
 * High-frequency updates never touch React directly: deltas are applied to
 * the mirror as they arrive, and the store is updated at most once per
 * animation frame (and not at all while the tab is hidden).
 */
class MarketFeed {
  private readonly mirror = new OrderBook();
  private epoch: string | null = null;
  private resyncPending = false;
  private frame: number | null = null;
  private pendingTrades: TradeDTO[] = [];
  private privateListeners = new Set<(msg: PrivateMessage) => void>();
  private wantAccount = false;

  private readonly socket = new ReconnectingSocket(wsUrl, {
    onOpen: () => this.subscribeAll(),
    onState: (socket, rttMs) => {
      useMarket.setState({ socket, rttMs });
      if (socket !== 'open') {
        this.mirror.reset();
        this.resyncPending = false;
        useMarket.setState({
          status: 'reconnecting',
          statusReason: 'connection to PaperPerp lost',
          authenticated: false,
        });
      }
    },
    onMessage: (msg) => this.onMessage(msg),
  });

  start() {
    this.socket.start();
  }

  stop() {
    this.socket.stop();
  }

  /** Re-handshake so the upgrade request carries (or drops) the session cookie. */
  setSignedIn(signedIn: boolean) {
    if (this.wantAccount === signedIn) return;
    this.wantAccount = signedIn;
    this.socket.restart();
  }

  get symbol(): MarketSymbol {
    return useMarket.getState().symbol;
  }

  /** Switch the viewed market: drop the old streams, clear its state, subscribe to the new one. */
  setSymbol(symbol: MarketSymbol) {
    const prev = this.symbol;
    if (symbol === prev) return;
    this.socket.send({ op: 'unsubscribe', channels: marketChannels(prev) });
    this.mirror.reset();
    this.epoch = null;
    this.resyncPending = false;
    this.pendingTrades = [];
    useMarket.setState({
      symbol,
      book: { bids: [], asks: [] },
      seq: -1,
      mid: undefined,
      trades: [],
      candle: null,
      status: 'reconnecting',
      statusReason: `loading ${symbol}`,
    });
    try {
      localStorage.setItem(SYMBOL_KEY, symbol);
    } catch {}
    this.socket.send({ op: 'subscribe', channels: marketChannels(symbol) });
  }

  onPrivate(fn: (msg: PrivateMessage) => void): () => void {
    this.privateListeners.add(fn);
    return () => this.privateListeners.delete(fn);
  }

  private subscribeAll() {
    this.socket.send({
      op: 'subscribe',
      channels: [...marketChannels(this.symbol), channels.tickers],
    });
  }

  private onMessage(msg: ServerMessage) {
    // Messages for a market we just switched away from can still be in flight.
    if ('symbol' in msg && msg.symbol !== this.symbol) return;
    switch (msg.type) {
      case 'hello':
        useMarket.setState({ authenticated: msg.authenticated });
        if (msg.authenticated && this.wantAccount) {
          this.socket.send({ op: 'subscribe', channels: [channels.account] });
        }
        return;
      case 'book.snapshot':
        this.epoch = msg.epoch;
        this.resyncPending = false;
        this.mirror.applySnapshot(msg.seq, msg.bids, msg.asks);
        this.schedule();
        return;
      case 'book.delta': {
        if (this.resyncPending) return;
        const result =
          msg.epoch !== this.epoch
            ? 'gap'
            : this.mirror.applyDelta(msg.prevSeq, msg.seq, msg.bids, msg.asks);
        if (result === 'gap' || result === 'uninitialized') this.resync();
        else if (result === 'applied') this.schedule();
        return;
      }
      case 'market.status':
        useMarket.setState({ status: msg.status, statusReason: msg.reason });
        return;
      case 'trades':
        if (msg.snapshot) useMarket.setState({ trades: msg.trades.slice(0, 40) });
        else {
          this.pendingTrades.push(...msg.trades);
          this.schedule();
        }
        return;
      case 'kline':
        useMarket.setState({ candle: msg.candle });
        return;
      case 'tickers':
        useMarket.setState({
          tickers: Object.fromEntries(msg.tickers.map((t) => [t.symbol, t])),
        });
        return;
      case 'order':
      case 'fill':
      case 'position':
      case 'account':
        for (const fn of this.privateListeners) fn(msg);
        return;
      case 'error':
        console.warn('[ws]', msg.code, msg.message);
        return;
    }
  }

  /** Sequence gap: ask the gateway for a fresh snapshot and ignore deltas until it arrives. */
  private resync() {
    this.resyncPending = true;
    useMarket.setState((s) => ({ resyncs: s.resyncs + 1 }));
    this.socket.send({ op: 'resync', symbol: this.symbol });
  }

  private schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private flush() {
    const patch: Partial<MarketState> = {
      book: this.mirror.top(BOOK_DEPTH),
      seq: this.mirror.seq,
      mid: this.mirror.mid(),
    };
    if (this.pendingTrades.length) {
      const fresh = this.pendingTrades.toReversed();
      this.pendingTrades = [];
      patch.trades = [...fresh, ...useMarket.getState().trades].slice(0, 40);
    }
    useMarket.setState(patch);
  }

  /** Test hook: feed a message as if it came from the socket. */
  _inject(msg: ServerMessage) {
    this.onMessage(msg);
  }
  _flushNow() {
    this.flush();
  }
}

function marketChannels(symbol: MarketSymbol): string[] {
  return [channels.book(symbol), channels.trades(symbol), channels.kline(symbol)];
}

export const marketFeed = new MarketFeed();

/**
 * Best known mark price for any market: the live mirror for the viewed one,
 * the tickers channel for the rest.
 */
export function markOf(
  state: Pick<MarketState, 'symbol' | 'mid' | 'tickers'>,
  symbol: string,
): number | undefined {
  if (symbol === state.symbol) return state.mid;
  return state.tickers[symbol as MarketSymbol]?.mid ?? undefined;
}
