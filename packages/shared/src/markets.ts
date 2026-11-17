import { decimalsOf } from './decimal';

export interface MarketConfig {
  symbol: string;
  base: string;
  quote: string;
  tickSize: string;
  stepSize: string;
  minSize: string;
  maxLeverage: number;
  /** Limit orders further than this from mid are rejected (fat-finger guard). */
  priceBandPct: number;
  upstream: { binance: string; hyperliquid: string };
}

export const MARKETS = {
  'BTC-PERP': {
    symbol: 'BTC-PERP',
    base: 'BTC',
    quote: 'USDC',
    tickSize: '0.1',
    stepSize: '0.001',
    minSize: '0.001',
    maxLeverage: 10,
    priceBandPct: 5,
    upstream: { binance: 'btcusdt', hyperliquid: 'BTC' },
  },
  'ETH-PERP': {
    symbol: 'ETH-PERP',
    base: 'ETH',
    quote: 'USDC',
    tickSize: '0.01',
    stepSize: '0.001',
    minSize: '0.001',
    maxLeverage: 10,
    priceBandPct: 5,
    upstream: { binance: 'ethusdt', hyperliquid: 'ETH' },
  },
  'SOL-PERP': {
    symbol: 'SOL-PERP',
    base: 'SOL',
    quote: 'USDC',
    tickSize: '0.01',
    stepSize: '0.01',
    minSize: '0.01',
    maxLeverage: 10,
    priceBandPct: 5,
    upstream: { binance: 'solusdt', hyperliquid: 'SOL' },
  },
} as const satisfies Record<string, MarketConfig>;

export type MarketSymbol = keyof typeof MARKETS;
export const SYMBOLS = Object.keys(MARKETS) as MarketSymbol[];
export const DEFAULT_SYMBOL: MarketSymbol = 'BTC-PERP';

export function isMarketSymbol(value: string): value is MarketSymbol {
  return Object.hasOwn(MARKETS, value);
}

export function getMarket(symbol: string): MarketConfig {
  if (!isMarketSymbol(symbol)) throw new Error(`unknown market: ${symbol}`);
  return MARKETS[symbol];
}

/** Decimal places to show prices of `symbol` with (its tick size). */
export function priceDecimals(symbol: string): number {
  return decimalsOf(getMarket(symbol).tickSize);
}

/** Decimal places to show sizes of `symbol` with (its step size). */
export function sizeDecimals(symbol: string): number {
  return decimalsOf(getMarket(symbol).stepSize);
}

/** Order size the form starts with: ten minimum lots, as a decimal string. */
export function defaultOrderSize(symbol: string): string {
  const m = getMarket(symbol);
  return (Number(m.minSize) * 10).toFixed(decimalsOf(m.stepSize));
}

/** Paper collateral credited to every new account. */
export const STARTING_BALANCE_USDC = 10_000;
export const TAKER_FEE_RATE = 0.00045;
export const MAKER_FEE_RATE = 0.00015;
