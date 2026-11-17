import { useMarket } from '../stores/market';
import { useToasts } from '../stores/toasts';

/** Read-only mode banner: tells the user why trading is paused instead of failing silently. */
export function StatusBanner() {
  const socket = useMarket((s) => s.socket);
  const status = useMarket((s) => s.status);
  const reason = useMarket((s) => s.statusReason);
  if (socket === 'open' && status === 'live') return null;
  const text =
    socket !== 'open'
      ? 'Connection to PaperPerp lost. Reconnecting… trading is paused.'
      : status === 'stale'
        ? `Market data is stale (${reason ?? 'no updates'}). Prices may be outdated; trading is paused.`
        : `Reconnecting to the exchange feed (${reason ?? 'waiting'})… trading is paused.`;
  return (
    <div className="banner" role="status" data-testid="status-banner">
      {text}
    </div>
  );
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
