export type Level = [price: number, size: number];

export interface BookView {
  bids: Level[];
  asks: Level[];
}

export type DeltaResult = 'applied' | 'gap' | 'duplicate' | 'uninitialized';

/**
 * Price-level book keyed by price. Used by the gateway (canonical copy) and
 * by the browser (mirror of the gateway's top-N view).
 *
 * Sequencing: every delta carries `prevSeq` and `seq`. A delta is applied
 * only when `prevSeq` equals the local `seq`; anything older is a duplicate
 * and anything newer means we missed a message and must resync from a
 * snapshot. Size 0 removes a level.
 */
export class OrderBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  seq = -1;

  get initialized(): boolean {
    return this.seq >= 0;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.seq = -1;
  }

  applySnapshot(seq: number, bids: Level[], asks: Level[]): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of bids) if (s > 0) this.bids.set(p, s);
    for (const [p, s] of asks) if (s > 0) this.asks.set(p, s);
    this.seq = seq;
  }

  applyDelta(prevSeq: number, seq: number, bids: Level[], asks: Level[]): DeltaResult {
    if (!this.initialized) return 'uninitialized';
    if (seq <= this.seq) return 'duplicate';
    if (prevSeq !== this.seq) return 'gap';
    this.applyLevels(bids, asks);
    this.seq = seq;
    return 'applied';
  }

  /** Apply level changes without sequence checks (upstream adapters own their sequencing). */
  applyLevels(bids: Level[], asks: Level[]): void {
    for (const [p, s] of bids) {
      if (s > 0) this.bids.set(p, s);
      else this.bids.delete(p);
    }
    for (const [p, s] of asks) {
      if (s > 0) this.asks.set(p, s);
      else this.asks.delete(p);
    }
  }

  /**
   * Best `depth` levels per side in one pass over the map, without sorting
   * the whole book: O(n · depth) with depth ≈ 25, versus O(n log n) for a
   * full sort. This runs every publish tick, so it must not grow with the
   * number of far-away levels the venue keeps sending.
   */
  top(depth: number): BookView {
    return { bids: bestLevels(this.bids, depth, true), asks: bestLevels(this.asks, depth, false) };
  }

  /** Total price levels held (both sides). */
  get size(): number {
    return this.bids.size + this.asks.size;
  }

  /**
   * Keep only the `maxLevels` best levels per side. Diff-depth feeds keep
   * adding levels far from the market that are never displayed or traded
   * against; without pruning the book (and every scan over it) grows forever.
   */
  prune(maxLevels: number): number {
    return pruneSide(this.bids, maxLevels, true) + pruneSide(this.asks, maxLevels, false);
  }

  bestBid(): number | undefined {
    let best: number | undefined;
    for (const p of this.bids.keys()) if (best === undefined || p > best) best = p;
    return best;
  }

  bestAsk(): number | undefined {
    let best: number | undefined;
    for (const p of this.asks.keys()) if (best === undefined || p < best) best = p;
    return best;
  }

  mid(): number | undefined {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return (bid + ask) / 2;
  }

  /** Remove crossed levels (can appear briefly when upstream books are merged). */
  uncross(): void {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid === undefined || ask === undefined || bid < ask) return;
    for (const p of [...this.bids.keys()]) if (p >= ask) this.bids.delete(p);
  }
}

/** Insertion into a small sorted buffer; `desc` for bids (highest first). */
function bestLevels(side: Map<number, number>, depth: number, desc: boolean): Level[] {
  const out: Level[] = [];
  if (depth <= 0) return out;
  const better = desc ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
  for (const [price, size] of side) {
    if (out.length === depth && !better(price, out[depth - 1]![0])) continue;
    let i = out.length < depth ? out.length : depth - 1;
    if (out.length < depth) out.push([price, size]);
    while (i > 0 && better(price, out[i - 1]![0])) {
      out[i] = out[i - 1]!;
      i--;
    }
    out[i] = [price, size];
  }
  return out;
}

function pruneSide(side: Map<number, number>, maxLevels: number, desc: boolean): number {
  const excess = side.size - maxLevels;
  if (excess <= 0) return 0;
  const prices = [...side.keys()].sort(desc ? (a, b) => b - a : (a, b) => a - b);
  for (let i = maxLevels; i < prices.length; i++) side.delete(prices[i]!);
  return excess;
}

/** Levels that changed between two views; removed levels get size 0. */
export function diffViews(prev: BookView, next: BookView): BookView {
  return { bids: diffSide(prev.bids, next.bids), asks: diffSide(prev.asks, next.asks) };
}

function diffSide(prev: Level[], next: Level[]): Level[] {
  const before = new Map(prev);
  const out: Level[] = [];
  for (const [p, s] of next) {
    if (before.get(p) !== s) out.push([p, s]);
    before.delete(p);
  }
  for (const p of before.keys()) out.push([p, 0]);
  return out;
}

export function viewsEqual(a: BookView, b: BookView): boolean {
  return sideEqual(a.bids, b.bids) && sideEqual(a.asks, b.asks);
}

function sideEqual(a: Level[], b: Level[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(([p, s], i) => b[i]![0] === p && b[i]![1] === s);
}
