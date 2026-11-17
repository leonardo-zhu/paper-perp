import { arbitrumSepolia, type Chain, mainnet, sepolia } from 'viem/chains';

const CHAINS: Record<number, Chain> = {
  [arbitrumSepolia.id]: arbitrumSepolia,
  [sepolia.id]: sepolia,
  [mainnet.id]: mainnet,
};

/** Chain the EIP-712 domain and SIWE messages are bound to. Must match the gateway. */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? arbitrumSepolia.id);
export const APP_CHAIN: Chain = CHAINS[CHAIN_ID] ?? arbitrumSepolia;

export const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
export const RELEASE = (import.meta.env.VITE_RELEASE as string | undefined) ?? 'dev';

export function wsUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}
