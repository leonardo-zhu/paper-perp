import { useState } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '../config';
import { chainName, useSession, useSignIn, useSignOut } from '../features/session';
import { describeError } from '../lib/api';
import { shortAddr } from '../lib/format';
import { toast } from '../stores/toasts';

export function WalletArea() {
  const conn = useConnection();
  const { data: session } = useSession();
  const signIn = useSignIn();
  const signOut = useSignOut();
  const { disconnect } = useDisconnect();
  const switchChain = useSwitchChain();
  const [picker, setPicker] = useState(false);

  if (conn.status !== 'connected' || !conn.address) {
    return (
      <>
        <button
          type="button"
          className="btn primary"
          onClick={() => setPicker(true)}
          disabled={conn.status === 'connecting' || conn.status === 'reconnecting'}
        >
          {conn.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
        </button>
        {picker && <ConnectorPicker onClose={() => setPicker(false)} />}
      </>
    );
  }

  const wrongChain = conn.chainId !== CHAIN_ID;
  const sessionMismatch = session && session.address !== conn.address;

  return (
    <div className="wallet">
      {wrongChain && (
        <button
          type="button"
          className="btn warn"
          onClick={() =>
            switchChain
              .mutateAsync({ chainId: CHAIN_ID })
              .catch((e) => toast.error(describeError(e)))
          }
        >
          Switch to {chainName}
        </button>
      )}
      {!session || sessionMismatch ? (
        <button
          type="button"
          className="btn primary"
          onClick={() => signIn.mutate()}
          disabled={signIn.isPending}
        >
          {signIn.isPending
            ? 'Check wallet…'
            : sessionMismatch
              ? 'Sign in with this account'
              : 'Sign in'}
        </button>
      ) : (
        <span
          className="pill ok"
          title={`Session until ${new Date(session.expiresAt).toLocaleString()}`}
        >
          Signed in
        </span>
      )}
      <details className="menu">
        <summary className="btn ghost mono">{shortAddr(conn.address)}</summary>
        <div className="menu-body">
          <div className="muted small">{conn.connector?.name}</div>
          {session && (
            <button type="button" className="btn ghost" onClick={() => signOut.mutate()}>
              Sign out
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              signOut.mutate();
              disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      </details>
    </div>
  );
}

function ConnectorPicker({ onClose }: { onClose: () => void }) {
  const connectors = useConnectors();
  const conn = useConnection();
  const connect = useConnect();
  // EIP-6963 announces each extension; drop the generic "Injected" fallback when real ones exist.
  const announced = connectors.filter((c) => c.id !== 'injected');
  const list = announced.length ? announced : connectors;
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Connect a wallet"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Connect a wallet</h3>
        {list.length === 0 && (
          <p className="muted">No browser wallet found. Install MetaMask or Rabby and reload.</p>
        )}
        {list.map((c) => (
          <button
            key={c.uid}
            type="button"
            className="connector"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(c.uid);
              try {
                await connect.mutateAsync({ connector: c, chainId: CHAIN_ID }).catch((err) => {
                  // Some wallets refuse to connect on an unknown chain; connect first, switch later.
                  if ((err as { name?: string }).name === 'SwitchChainError') {
                    return connect.mutateAsync({ connector: c });
                  }
                  throw err;
                });
                onClose();
              } catch (err) {
                toast.error(describeError(err));
              } finally {
                setBusy(null);
              }
            }}
          >
            {c.icon ? <img src={c.icon} alt="" width={22} height={22} /> : <span className="dot" />}
            <span>{c.name}</span>
            {busy === c.uid && <span className="muted small">Check wallet…</span>}
          </button>
        ))}
        <p className="muted small">
          Paper trading only. Signing in never sends a transaction.{' '}
          {conn.status === 'reconnecting' && 'Reconnecting…'}
        </p>
      </div>
    </div>
  );
}
