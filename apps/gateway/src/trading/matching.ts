import { type OrderBook, round, type Side } from '@paperperp/shared';

export interface FillPlan {
  price: number;
  size: number;
}

/**
 * Walk the opposite side of the real book up to `limitPrice`.
 * The simulation does not consume upstream liquidity: two orders a moment
 * apart can both take the same level. Acceptable for paper trading and
 * documented in ADR-0002.
 */
export function planFills(
  book: OrderBook,
  side: Side,
  limitPrice: number,
  size: number,
  sizeDecimals: number,
): FillPlan[] {
  const levels =
    side === 'buy'
      ? [...book.asks].filter(([p]) => p <= limitPrice).sort((a, b) => a[0] - b[0])
      : [...book.bids].filter(([p]) => p >= limitPrice).sort((a, b) => b[0] - a[0]);
  const plans: FillPlan[] = [];
  let remaining = size;
  for (const [price, available] of levels) {
    if (remaining <= 0) break;
    const take = floorTo(Math.min(available, remaining), sizeDecimals);
    if (take <= 0) continue;
    plans.push({ price, size: take });
    remaining = round(remaining - take, sizeDecimals);
  }
  return plans;
}

export interface PositionState {
  size: number;
  entryPrice: number;
  realizedPnl: number;
}

/**
 * One-way (netted) position accounting.
 *  - adding to a position re-averages the entry price
 *  - reducing realises PnL against the entry price
 *  - flipping closes the old side and opens the rest at the fill price
 */
export function applyFill(
  pos: PositionState,
  side: Side,
  qty: number,
  price: number,
  sizeDecimals: number,
): PositionState & { realized: number } {
  const signed = side === 'buy' ? qty : -qty;
  const newSize = round(pos.size + signed, sizeDecimals);

  if (pos.size === 0 || Math.sign(pos.size) === Math.sign(signed)) {
    const entry = (Math.abs(pos.size) * pos.entryPrice + qty * price) / Math.abs(newSize);
    return { size: newSize, entryPrice: entry, realizedPnl: pos.realizedPnl, realized: 0 };
  }

  const closing = Math.min(qty, Math.abs(pos.size));
  const realized = round(closing * (price - pos.entryPrice) * Math.sign(pos.size), 6);
  let entry = pos.entryPrice;
  if (newSize === 0) entry = 0;
  else if (Math.sign(newSize) !== Math.sign(pos.size)) entry = price;
  return {
    size: newSize,
    entryPrice: entry,
    realizedPnl: round(pos.realizedPnl + realized, 6),
    realized,
  };
}

function floorTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}
