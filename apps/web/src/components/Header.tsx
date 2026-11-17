import { fmtPrice } from '../lib/format';
import { useMarket } from '../stores/market';
import { WalletArea } from './WalletArea';

export function Header() {
  const mid = useMarket((s) => s.mid);
  const book = useMarket((s) => s.book);
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
        <span className="symbol">BTC-PERP</span>
        <span className="mono big" data-testid="mid-price">
          {fmtPrice(mid)}
        </span>
        <span className="muted small">spread {spread !== undefined ? spread.toFixed(1) : '—'}</span>
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
