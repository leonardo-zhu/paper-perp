import type { SessionDTO } from '@paperperp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useConfig, useConnection } from 'wagmi';
import { getConnection, signMessage, switchChain } from 'wagmi/actions';
import { APP_CHAIN, CHAIN_ID } from '../config';
import { ApiError, api, describeError } from '../lib/api';
import { useMarket } from '../stores/market';
import { toast } from '../stores/toasts';

export const sessionKey = ['session'] as const;

/** Tabs tell each other about sign-in/out so they never disagree about the session. */
const authChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('paperperp-auth') : null;

export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: async () => {
      try {
        return await api<SessionDTO>('/api/auth/session');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useAuthSync() {
  const qc = useQueryClient();
  useEffect(() => {
    if (!authChannel) return;
    const onMessage = () => {
      void qc.invalidateQueries();
    };
    authChannel.addEventListener('message', onMessage);
    return () => authChannel.removeEventListener('message', onMessage);
  }, [qc]);
}

export function useSignIn() {
  const config = useConfig();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { address, chainId } = getConnection(config);
      if (!address) throw new Error('Connect your wallet first.');
      if (chainId !== CHAIN_ID) await switchChain(config, { chainId: CHAIN_ID });
      const { nonce } = await api<{ nonce: string }>('/api/auth/nonce');
      const message = createSiweMessage({
        address,
        chainId: CHAIN_ID,
        domain: window.location.host,
        uri: window.location.origin,
        version: '1',
        nonce,
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 24 * 3_600_000),
        statement:
          'Sign in to PaperPerp, a paper-trading demo. This request does not send a transaction or cost gas.',
      });
      const signature = await signMessage(config, { account: address, message });
      return api<SessionDTO>('/api/auth/verify', { body: { message, signature } });
    },
    onSuccess: (session) => {
      qc.setQueryData(sessionKey, session);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
      authChannel?.postMessage('changed');
      toast.success('Signed in. You start with 10,000 paper USDC.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST', body: {} }),
    onSettled: () => {
      qc.setQueryData(sessionKey, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
      authChannel?.postMessage('changed');
    },
  });
}

export type GateReason =
  | { kind: 'connect' }
  | { kind: 'switch-chain' }
  | { kind: 'sign-in' }
  | { kind: 'account-changed'; session: string }
  | { kind: 'market'; text: string }
  | { kind: 'ok' };

/** Single place that decides whether the user may trade right now, and why not. */
export function useTradingGate(): GateReason {
  const conn = useConnection();
  const { data: session } = useSession();
  const status = useMarket((s) => s.status);
  const reason = useMarket((s) => s.statusReason);
  if (conn.status !== 'connected' || !conn.address) return { kind: 'connect' };
  if (!session) return { kind: 'sign-in' };
  if (session.address !== conn.address)
    return { kind: 'account-changed', session: session.address };
  if (conn.chainId !== CHAIN_ID) return { kind: 'switch-chain' };
  if (status !== 'live') {
    return {
      kind: 'market',
      text:
        status === 'stale'
          ? `Market data is stale (${reason}). Trading is paused.`
          : 'Reconnecting to market data…',
    };
  }
  return { kind: 'ok' };
}

export const chainName = APP_CHAIN.name;
