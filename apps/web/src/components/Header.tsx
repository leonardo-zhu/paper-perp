import { isMarketSymbol, priceDecimals, SYMBOLS } from '@paperperp/shared';
import { fmtPrice } from '../lib/format';
import { marketFeed, useMarket } from '../stores/market';
import { useOrderForm } from '../stores/order-form';
import { WalletArea } from './WalletArea';

export function Header() {
  const symbol = useMarket((s) => s.symbol);
  const mid = useMarket((s) => s.mid);
  const book = useMarket((s) => s.book);
  const dp = priceDecimals(symbol);
  const spread = book.asks[0] && book.bids[0] ? book.asks[0][0] - book.bids[0][0] : undefined;
  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <path
            d="M5 23l7-8 6 4 9-11"
            stroke="currentColor"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>PaperPerp</span>
        <span className="pill">paper</span>
      </div>
      <div className="ticker">
        <select
          className="symbol market-select"
          aria-label="Market"
          value={symbol}
          onChange={(e) => {
            const next = e.target.value;
            if (!isMarketSymbol(next)) return;
            marketFeed.setSymbol(next);
            useOrderForm.getState().resetFor(next);
          }}
        >
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="mono big" data-testid="mid-price">
          {fmtPrice(mid, dp)}
        </span>
        <span className="muted small">
          spread {spread !== undefined ? spread.toFixed(dp) : '—'}
        </span>
      </div>
      <ConnectionIndicator />
      <WalletArea />
    </header>
  );
}

function ConnectionIndicator() {
  const socket = useMarket((s) => s.socket);
  const status = useMarket((s) => s.status);
  const rtt = useMarket((s) => s.rttMs);
  const seq = useMarket((s) => s.seq);
  const resyncs = useMarket((s) => s.resyncs);
  const tone = socket !== 'open' ? 'down' : status === 'live' ? 'up' : 'warn';
  const label = socket !== 'open' ? socket : status;
  return (
    <div
      className="conn"
      title={`seq ${seq} · resyncs ${resyncs}`}
      data-testid="market-status"
      data-status={label}
    >
      <span className={`dot ${tone}`} />
      <span className="small">{label}</span>
      {rtt !== null && socket === 'open' && <span className="muted small mono">{rtt}ms</span>}
    </div>
  );
}
