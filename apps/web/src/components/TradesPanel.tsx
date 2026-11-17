import { priceDecimals, sizeDecimals } from '@paperperp/shared';
import { fmtPrice, fmtSize, fmtTime } from '../lib/format';
import { useMarket } from '../stores/market';

export function TradesPanel() {
  const symbol = useMarket((s) => s.symbol);
  const trades = useMarket((s) => s.trades);
  const dp = priceDecimals(symbol);
  const sdp = sizeDecimals(symbol);
  return (
    <section className="panel trades" aria-label="Recent trades">
      <header className="panel-head">
        <h2>Trades</h2>
      </header>
      <div className="book-cols muted small">
        <span>Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      <div className="trade-list">
        {trades.slice(0, 30).map((t) => (
          <div key={t.id} className="trade-row">
            <span className={`mono ${t.side === 'buy' ? 'up' : 'down'}`}>
              {fmtPrice(t.price, dp)}
            </span>
            <span className="mono">{fmtSize(t.size, sdp)}</span>
            <span className="mono muted">{fmtTime(t.ts)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
