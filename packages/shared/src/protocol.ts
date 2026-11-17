import type { AccountDTO, Candle, FillDTO, OrderDTO, PositionDTO, TradeDTO } from './dto';
import type { Level } from './orderbook';

/**
 * WebSocket protocol between gateway and browser.
 *
 * Channels:  book:<SYMBOL>  trades:<SYMBOL>  kline:<SYMBOL>:1m  tickers  account (needs session)
 *
 * `tickers` carries every market's mid and status about once a second, so a
 * client watching one market can still mark positions in the others.
 *
 * Book stream: on subscribe (and on `resync`) the gateway sends a snapshot,
 * then deltas with strictly consecutive `seq`. `epoch` changes when the
 * gateway restarts, so a client never mixes sequence numbers across restarts.
 */
export type MarketStatus = 'live' | 'stale' | 'reconnecting';

export interface Ticker {
  symbol: string;
  mid: number | null;
  status: MarketStatus;
}

export type ServerMessage =
  | { type: 'hello'; epoch: string; serverTime: number; authenticated: boolean }
  | {
      type: 'book.snapshot';
      symbol: string;
      epoch: string;
      seq: number;
      bids: Level[];
      asks: Level[];
      ts: number;
    }
  | {
      type: 'book.delta';
      symbol: string;
      epoch: string;
      prevSeq: number;
      seq: number;
      bids: Level[];
      asks: Level[];
      ts: number;
    }
  | { type: 'trades'; symbol: string; trades: TradeDTO[]; snapshot: boolean }
  | { type: 'kline'; symbol: string; interval: '1m'; candle: Candle }
  | { type: 'tickers'; tickers: Ticker[] }
  | {
      type: 'market.status';
      symbol: string;
      status: MarketStatus;
      reason: string | null;
      since: number;
    }
  | { type: 'subscribed'; channels: string[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; ts: number; serverTime: number }
  | { type: 'order'; order: OrderDTO }
  | { type: 'fill'; fill: FillDTO }
  | { type: 'position'; position: PositionDTO }
  | { type: 'account'; account: AccountDTO };

export type ClientMessage =
  | { op: 'subscribe'; channels: string[] }
  | { op: 'unsubscribe'; channels: string[] }
  | { op: 'resync'; symbol: string }
  | { op: 'ping'; ts: number };

export const channels = {
  book: (symbol: string) => `book:${symbol}`,
  trades: (symbol: string) => `trades:${symbol}`,
  kline: (symbol: string) => `kline:${symbol}:1m`,
  tickers: 'tickers',
  account: 'account',
} as const;

/** Gateway publishes the top N levels per side. */
export const BOOK_DEPTH = 25;
/** How often the gateway coalesces upstream updates into one delta (ms). */
export const BOOK_PUBLISH_INTERVAL_MS = 100;
/** How often the gateway publishes the `tickers` channel (ms). */
export const TICKER_INTERVAL_MS = 1_000;
/** Client sends a ping this often; server drops clients silent for 3x this. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
