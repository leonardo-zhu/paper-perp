import { type ApproveAgentMessage, approveAgentTypedData, toWire } from '@paperperp/shared';
import { useCallback, useMemo } from 'react';
import type { Address, Hex, TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { useConfig } from 'wagmi';
import { signTypedData } from 'wagmi/actions';
import { create } from 'zustand';
import { CHAIN_ID } from '../config';
import { api } from '../lib/api';

/**
 * Agent ("trading key"): a browser-generated key the main wallet authorises
 * once via EIP-712. Orders are then signed locally — no wallet popup per
 * order. The key can only trade this paper account, expires after 24h and
 * can be revoked. It lives in localStorage, so an XSS bug could use it
 * until it expires; that trade-off is discussed in ADR-0003.
 */
interface StoredAgent {
  pk: Hex;
  address: Address;
  validUntil: number; // ms
}

const AGENT_TTL_SEC = 24 * 3600;
const storageKey = (account: Address) => `pp.agent.${CHAIN_ID}.${account}`;

function load(account: Address | undefined): StoredAgent | null {
  if (!account) return null;
  try {
    const raw = localStorage.getItem(storageKey(account));
    if (!raw) return null;
    const agent = JSON.parse(raw) as StoredAgent;
    return agent.validUntil > Date.now() + 60_000 ? agent : null;
  } catch {
    return null;
  }
}

function save(account: Address, agent: StoredAgent | null) {
  try {
    if (agent) localStorage.setItem(storageKey(account), JSON.stringify(agent));
    else localStorage.removeItem(storageKey(account));
  } catch {
    /* storage unavailable: agent simply won't persist */
  }
}

let lastNonce = 0n;
/** Millisecond-based, strictly increasing, with random low digits so two tabs don't collide. */
export function nextNonce(): bigint {
  const candidate = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n;
  return lastNonce;
}

export function deadlineIn(seconds: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

/** Bumped whenever an agent is stored or removed, so every component re-reads it. */
const useAgentRevision = create(() => ({ rev: 0 }));
const bump = () => useAgentRevision.setState((s) => ({ rev: s.rev + 1 }));

export function useSigner(account: Address | undefined) {
  const config = useConfig();
  const rev = useAgentRevision((s) => s.rev);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev is the invalidation signal
  const agent = useMemo(() => load(account), [account, rev]);

  const approve = useCallback(
    async (enable: boolean) => {
      if (!account) throw new Error('Connect your wallet first.');
      const pk = generatePrivateKey();
      const target = enable ? privateKeyToAccount(pk).address : agent?.address;
      if (!target) return;
      const validUntil = enable ? BigInt(Math.floor(Date.now() / 1000) + AGENT_TTL_SEC) : 0n;
      const approval: ApproveAgentMessage = {
        account,
        agent: target,
        validUntil,
        nonce: nextNonce(),
      };
      const signature = await signTypedData(config, {
        account,
        ...approveAgentTypedData(CHAIN_ID, approval),
      });
      await api('/api/agents', {
        body: { approval: toWire(approval), signature, chainId: CHAIN_ID },
      });
      const next = enable ? { pk, address: target, validUntil: Number(validUntil) * 1000 } : null;
      save(account, next);
      bump();
    },
    [account, agent, config],
  );

  const forget = useCallback(() => {
    if (account) save(account, null);
    bump();
  }, [account]);

  /** Sign with the agent when one is active, otherwise ask the wallet. */
  const sign = useCallback(
    async (typed: TypedDataDefinition): Promise<Hex> => {
      if (!account) throw new Error('Connect your wallet first.');
      const active = load(account);
      if (active) return privateKeyToAccount(active.pk).signTypedData(typed as never);
      return signTypedData(config, { account, ...(typed as object) } as never);
    },
    [account, config],
  );

  return {
    agent,
    sign,
    enableAgent: () => approve(true),
    revokeAgent: () => approve(false),
    forgetAgent: forget,
  };
}
