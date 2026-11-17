import type { Level } from '@paperperp/shared';
import { memo, useMemo } from 'react';
import { fmtPrice, fmtSize } from '../lib/format';
import { useMarket } from '../stores/market';
import { useOrderForm } from '../stores/order-form';

const ROWS = 12;

export function OrderBookPanel() {
  const book = useMarket((s) => s.book);
  const status = useMarket((s) => s.status);
  const setForm = useOrderForm((s) => s.set);

  const { asks, bids, max } = useMemo(() => {
    const asks = withTotals(book.asks.slice(0, ROWS));
    const bids = withTotals(book.bids.slice(0, ROWS));
    const max = Math.max(asks.at(-1)?.[2] ?? 0, bids.at(-1)?.[2] ?? 0);
    return { asks: asks.toReversed(), bids, max };
  }, [book]);

  const bestBid = book.bids[0]?.[0];
  const bestAsk = book.asks[0]?.[0];
  const spread = bestBid && bestAsk ? bestAsk - bestBid : undefined;
  const pick = (price: number) => setForm({ price: price.toFixed(1), type: 'limit' });

  return (
    <section className={`panel book ${status !== 'live' ? 'dimmed' : ''}`} aria-label="Order book">
      <header className="panel-head">
        <h2>Order book</h2>
      </header>
      <div className="book-cols muted small">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>
      <div className="book-side asks">
        {asks.map(([p, s, t]) => (
          <Row key={p} price={p} size={s} total={t} max={max} side="ask" onPick={pick} />
        ))}
      </div>
      <div className="spread" data-testid="spread">
        <span className="mono">
          {fmtPrice(bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined)}
        </span>
        <span className="muted small">spread {spread !== undefined ? spread.toFixed(1) : '—'}</span>
      </div>
      <div className="book-side bids" data-testid="bids">
        {bids.map(([p, s, t]) => (
          <Row key={p} price={p} size={s} total={t} max={max} side="bid" onPick={pick} />
        ))}
      </div>
    </section>
  );
}

const Row = memo(function Row(props: {
  price: number;
  size: number;
  total: number;
  max: number;
  side: 'bid' | 'ask';
  onPick: (p: number) => void;
}) {
  const pct = props.max ? (props.total / props.max) * 100 : 0;
  return (
    <div className={`book-row ${props.side}`} onClick={() => props.onPick(props.price)}>
      <div className="depth" style={{ width: `${pct}%` }} />
      <span className="mono price">{fmtPrice(props.price)}</span>
      <span className="mono">{fmtSize(props.size)}</span>
      <span className="mono muted">{fmtSize(props.total)}</span>
    </div>
  );
});

function withTotals(levels: Level[]): [number, number, number][] {
  let total = 0;
  return levels.map(([p, s]) => {
    total += s;
    return [p, s, total];
  });
}
