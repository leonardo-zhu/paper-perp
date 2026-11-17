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

/** Paper collateral credited to every new account. */
export const STARTING_BALANCE_USDC = 10_000;
export const TAKER_FEE_RATE = 0.00045;
export const MAKER_FEE_RATE = 0.00015;
