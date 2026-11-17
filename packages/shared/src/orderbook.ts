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

  top(depth: number): BookView {
    return {
      bids: [...this.bids].sort((a, b) => b[0] - a[0]).slice(0, depth),
      asks: [...this.asks].sort((a, b) => a[0] - b[0]).slice(0, depth),
    };
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
