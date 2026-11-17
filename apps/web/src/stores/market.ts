import {
  BOOK_DEPTH,
  type BookView,
  type Candle,
  channels,
  DEFAULT_SYMBOL,
  type MarketStatus,
  OrderBook,
  type ServerMessage,
  type TradeDTO,
} from '@paperperp/shared';
import { create } from 'zustand';
import { wsUrl } from '../config';
import { ReconnectingSocket, type SocketState } from '../lib/socket';

export interface MarketState {
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
  readonly symbol = DEFAULT_SYMBOL;
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

  onPrivate(fn: (msg: PrivateMessage) => void): () => void {
    this.privateListeners.add(fn);
    return () => this.privateListeners.delete(fn);
  }

  private subscribeAll() {
    this.socket.send({
      op: 'subscribe',
      channels: [
        channels.book(this.symbol),
        channels.trades(this.symbol),
        channels.kline(this.symbol),
      ],
    });
  }

  private onMessage(msg: ServerMessage) {
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

export const marketFeed = new MarketFeed();
