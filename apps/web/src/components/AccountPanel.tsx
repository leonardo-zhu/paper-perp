import {
  isTerminal,
  type MarketSymbol,
  type OrderDTO,
  type PositionDTO,
  priceDecimals,
  sizeDecimals,
} from '@paperperp/shared';
import { useState } from 'react';
import { useSession, useTradingGate } from '../features/session';
import {
  liveUnrealized,
  useAccountData,
  useCancelOrder,
  useFills,
  useOrders,
  usePlaceOrder,
  useResetAccount,
} from '../features/trading';
import { fmtPrice, fmtSigned, fmtSize, fmtTime, fmtUsd } from '../lib/format';
import { markOf, useMarket } from '../stores/market';

type MarkFn = (symbol: string) => number | undefined;

type Tab = 'positions' | 'open' | 'history' | 'fills';

export function AccountPanel() {
  const { data: session } = useSession();
  const [tab, setTab] = useState<Tab>('positions');
  const account = useAccountData();
  const orders = useOrders();
  const fills = useFills();
  const symbol = useMarket((s) => s.symbol);
  const mid = useMarket((s) => s.mid);
  const tickers = useMarket((s) => s.tickers);
  const markFor: MarkFn = (sym) => markOf({ symbol, mid, tickers }, sym);
  const reset = useResetAccount();

  if (!session) {
    return (
      <section className="panel account empty">
        <p className="muted">Connect and sign in to see positions and orders.</p>
      </section>
    );
  }

  const positions = (account.data?.positions ?? []).filter((p) => p.size !== 0);
  const open = (orders.data ?? []).filter((o) => !isTerminal(o.status));
  const history = (orders.data ?? []).filter((o) => isTerminal(o.status));
  const a = account.data?.account;
  const upnl = positions.reduce((n, p) => n + liveUnrealized(p, markFor(p.symbol)), 0);
  const equity = a ? a.balance + upnl : undefined;

  return (
    <section className="panel account" aria-label="Account">
      <div className="account-summary">
        <Stat label="Equity" value={fmtUsd(equity)} />
        <Stat label="Balance" value={fmtUsd(a?.balance)} />
        <Stat label="Unrealized PnL" value={fmtSigned(upnl)} tone={upnl >= 0 ? 'up' : 'down'} />
        <Stat label="Margin used" value={fmtUsd(a?.usedMargin)} />
        <Stat label="Available" value={fmtUsd(a?.available)} />
        <button
          type="button"
          className="btn ghost small"
          onClick={() => confirm('Reset paper account to 10,000 USDC?') && reset.mutate()}
        >
          Reset
        </button>
      </div>
      <div className="tabs">
        {(
          [
            ['positions', `Positions (${positions.length})`],
            ['open', `Open orders (${open.length})`],
            ['history', 'Order history'],
            ['fills', 'Fills'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        {tab === 'positions' && <Positions positions={positions} markFor={markFor} />}
        {tab === 'open' && <Orders orders={open} cancellable />}
        {tab === 'history' && <Orders orders={history} />}
        {tab === 'fills' && (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Side</th>
                <th>Price</th>
                <th>Size</th>
                <th>Fee</th>
                <th>Liquidity</th>
                <th>Realized PnL</th>
              </tr>
            </thead>
            <tbody>
              {(fills.data ?? []).map((f) => (
                <tr key={f.id}>
                  <td className="mono">{fmtTime(f.ts)}</td>
                  <td>{f.symbol}</td>
                  <td className={f.side === 'buy' ? 'up' : 'down'}>{f.side}</td>
                  <td className="mono">{fmtPrice(f.price, priceDecimals(f.symbol))}</td>
                  <td className="mono">{fmtSize(f.size, sizeDecimals(f.symbol))}</td>
                  <td className="mono">{fmtUsd(f.fee)}</td>
                  <td>{f.liquidity}</td>
                  <td className={`mono ${f.realizedPnl >= 0 ? 'up' : 'down'}`}>
                    {f.realizedPnl ? fmtSigned(f.realizedPnl) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="stat">
      <span className="muted small">{label}</span>
      <span className={`mono ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function Positions({ positions, markFor }: { positions: PositionDTO[]; markFor: MarkFn }) {
  const place = usePlaceOrder();
  const gate = useTradingGate();
  if (!positions.length) return <p className="muted pad">No open positions.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Market</th>
          <th>Size</th>
          <th>Entry</th>
          <th>Mark</th>
          <th>Unrealized PnL</th>
          <th>Realized PnL</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const mark = markFor(p.symbol);
          const upnl = liveUnrealized(p, mark);
          const pdp = priceDecimals(p.symbol);
          const dp = sizeDecimals(p.symbol);
          return (
            <tr key={p.symbol} data-testid="position-row">
              <td>{p.symbol}</td>
              <td className={`mono ${p.size > 0 ? 'up' : 'down'}`}>{fmtSize(p.size, dp)}</td>
              <td className="mono">{fmtPrice(p.entryPrice, pdp)}</td>
              <td className="mono">{fmtPrice(mark ?? p.markPrice, pdp)}</td>
              <td className={`mono ${upnl >= 0 ? 'up' : 'down'}`}>{fmtSigned(upnl)}</td>
              <td className="mono">{fmtSigned(p.realizedPnl)}</td>
              <td>
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={gate.kind !== 'ok' || place.isPending}
                  onClick={() =>
                    place.mutate({
                      symbol: p.symbol as MarketSymbol,
                      side: p.size > 0 ? 'sell' : 'buy',
                      type: 'market',
                      price: '',
                      size: Math.abs(p.size).toFixed(dp),
                      reduceOnly: true,
                      slippagePct: 1,
                    })
                  }
                >
                  Close
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Orders({ orders, cancellable }: { orders: OrderDTO[]; cancellable?: boolean }) {
  const cancel = useCancelOrder();
  if (!orders.length)
    return <p className="muted pad">{cancellable ? 'No open orders.' : 'No orders yet.'}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Market</th>
          <th>Side</th>
          <th>Type</th>
          <th>Price</th>
          <th>Filled / Size</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.cloid} data-testid="order-row" data-status={o.status}>
            <td className="mono">{fmtTime(o.createdAt)}</td>
            <td>{o.symbol}</td>
            <td className={o.side === 'buy' ? 'up' : 'down'}>
              {o.side}
              {o.reduceOnly ? ' (RO)' : ''}
            </td>
            <td>{o.type}</td>
            <td className="mono">{fmtPrice(o.avgFillPrice ?? o.price, priceDecimals(o.symbol))}</td>
            <td className="mono">
              {fmtSize(o.filledSize, sizeDecimals(o.symbol))} /{' '}
              {fmtSize(o.size, sizeDecimals(o.symbol))}
            </td>
            <td>
              <span className={`status ${o.status}`} title={o.reason ?? undefined}>
                {o.status.replace('_', ' ')}
              </span>
              {o.reason && <span className="muted small"> {o.reason.replaceAll('_', ' ')}</span>}
            </td>
            <td>
              {cancellable && o.status !== 'pending' && (
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(o)}
                >
                  Cancel
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
