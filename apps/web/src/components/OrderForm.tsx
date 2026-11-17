import {
  getMarket,
  isDecimalString,
  isMultipleOf,
  type MarketConfig,
  priceDecimals,
} from '@paperperp/shared';
import { useState } from 'react';
import { useConnection, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '../config';
import { chainName, useSignIn, useTradingGate } from '../features/session';
import { useSigner } from '../features/signer';
import { useAccountData, usePlaceOrder, worstPrice } from '../features/trading';
import { describeError } from '../lib/api';
import { fmtUsd } from '../lib/format';
import { useMarket } from '../stores/market';
import { useOrderForm } from '../stores/order-form';
import { toast } from '../stores/toasts';

export function OrderForm() {
  const form = useOrderForm();
  const symbol = useMarket((s) => s.symbol);
  const market = getMarket(symbol);
  const dp = priceDecimals(symbol);
  const mid = useMarket((s) => s.mid);
  const gate = useTradingGate();
  const place = usePlaceOrder();
  const account = useAccountData();
  const signIn = useSignIn();
  const switchChain = useSwitchChain();
  const { address } = useConnection();
  const { agent, enableAgent, revokeAgent } = useSigner(address);
  const [agentBusy, setAgentBusy] = useState(false);

  const refPrice = form.type === 'limit' ? Number(form.price) : mid;
  const notional = refPrice && Number(form.size) ? refPrice * Number(form.size) : 0;
  const margin = notional / market.maxLeverage;
  const available = account.data?.account.available;
  const validation = validate(market, form.type, form.price, form.size);
  const canSubmit = gate.kind === 'ok' && !validation && !place.isPending;

  const submit = () => {
    if (!canSubmit) return;
    place.mutate({ ...form });
  };

  return (
    <section className="panel form" aria-label="Place order">
      <div className="tabs side">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`tab ${s} ${form.side === s ? 'active' : ''}`}
            onClick={() => form.set({ side: s })}
          >
            {s === 'buy' ? 'Buy / Long' : 'Sell / Short'}
          </button>
        ))}
      </div>
      <div className="tabs type">
        {(['limit', 'market'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`tab ${form.type === t ? 'active' : ''}`}
            onClick={() => form.set({ type: t })}
          >
            {t === 'limit' ? 'Limit' : 'Market'}
          </button>
        ))}
      </div>

      {form.type === 'limit' ? (
        <label className="field">
          <span>Price ({market.quote})</span>
          <input
            inputMode="decimal"
            value={form.price}
            placeholder={mid ? mid.toFixed(dp) : ''}
            onChange={(e) => form.set({ price: e.target.value.trim() })}
          />
          <button
            type="button"
            className="link small"
            onClick={() => mid && form.set({ price: mid.toFixed(dp) })}
          >
            Mid
          </button>
        </label>
      ) : (
        <label className="field">
          <span>Max slippage</span>
          <select
            value={form.slippagePct}
            onChange={(e) => form.set({ slippagePct: Number(e.target.value) })}
          >
            {[0.1, 0.5, 1, 2].map((p) => (
              <option key={p} value={p}>
                {p}% (worst {mid ? worstPrice(form.side, mid, p, market.tickSize) : '—'})
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>Size ({market.base})</span>
        <input
          inputMode="decimal"
          value={form.size}
          onChange={(e) => form.set({ size: e.target.value.trim() })}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={form.reduceOnly}
          onChange={(e) => form.set({ reduceOnly: e.target.checked })}
        />
        Reduce only
      </label>

      <dl className="summary">
        <dt>Notional</dt>
        <dd className="mono">{fmtUsd(notional)}</dd>
        <dt>Margin ({market.maxLeverage}x)</dt>
        <dd className="mono">{fmtUsd(margin)}</dd>
        <dt>Available</dt>
        <dd className="mono">{fmtUsd(available)}</dd>
      </dl>

      {gate.kind === 'ok' && validation && <p className="hint warn">{validation}</p>}

      <GateAction
        gate={gate}
        onSignIn={() => signIn.mutate()}
        onSwitch={() =>
          switchChain.mutateAsync({ chainId: CHAIN_ID }).catch((e) => toast.error(describeError(e)))
        }
      />

      <button
        type="button"
        className={`btn submit ${form.side}`}
        disabled={!canSubmit}
        onClick={submit}
        data-testid="submit-order"
      >
        {place.isPending
          ? agent
            ? 'Submitting…'
            : 'Confirm in wallet…'
          : `${form.side === 'buy' ? 'Buy' : 'Sell'} ${market.base} ${form.type}`}
      </button>

      {gate.kind === 'ok' && (
        <div className="agent">
          <div>
            <strong>1-click trading</strong>
            <p className="muted small">
              {agent
                ? `Trading key active until ${new Date(agent.validUntil).toLocaleTimeString()}. Orders are signed in the browser.`
                : 'Approve a temporary trading key once; orders won’t need a wallet popup.'}
            </p>
          </div>
          <button
            type="button"
            className="btn ghost"
            disabled={agentBusy}
            onClick={async () => {
              setAgentBusy(true);
              try {
                await (agent ? revokeAgent() : enableAgent());
                toast.success(agent ? 'Trading key revoked.' : '1-click trading enabled for 24h.');
              } catch (err) {
                toast.error(describeError(err));
              } finally {
                setAgentBusy(false);
              }
            }}
          >
            {agentBusy ? 'Check wallet…' : agent ? 'Revoke' : 'Enable'}
          </button>
        </div>
      )}
    </section>
  );
}

function GateAction({
  gate,
  onSignIn,
  onSwitch,
}: {
  gate: ReturnType<typeof useTradingGate>;
  onSignIn(): void;
  onSwitch(): void;
}) {
  switch (gate.kind) {
    case 'ok':
      return null;
    case 'connect':
      return <p className="hint">Connect a wallet to trade.</p>;
    case 'sign-in':
      return (
        <p className="hint">
          <button type="button" className="link" onClick={onSignIn}>
            Sign in
          </button>{' '}
          to start with 10,000 paper USDC.
        </p>
      );
    case 'account-changed':
      return (
        <p className="hint warn">
          Your wallet switched accounts.{' '}
          <button type="button" className="link" onClick={onSignIn}>
            Sign in again
          </button>
        </p>
      );
    case 'switch-chain':
      return (
        <p className="hint warn">
          Wrong network.{' '}
          <button type="button" className="link" onClick={onSwitch}>
            Switch to {chainName}
          </button>
        </p>
      );
    case 'market':
      return <p className="hint warn">{gate.text}</p>;
  }
}

function validate(
  market: MarketConfig,
  type: 'limit' | 'market',
  price: string,
  size: string,
): string | null {
  if (!isDecimalString(size) || Number(size) <= 0) return 'Enter a size.';
  if (Number(size) < Number(market.minSize)) return `Minimum size is ${market.minSize}.`;
  if (!isMultipleOf(size, market.stepSize)) return `Size must be a multiple of ${market.stepSize}.`;
  if (type === 'limit') {
    if (!isDecimalString(price) || Number(price) <= 0) return 'Enter a price.';
    if (!isMultipleOf(price, market.tickSize))
      return `Price must be a multiple of ${market.tickSize}.`;
  }
  return null;
}
