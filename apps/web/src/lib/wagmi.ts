import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { APP_CHAIN } from '../config';

/**
 * Injected wallets only. wagmi discovers every installed extension through
 * EIP-6963 (MetaMask, Rabby, OKX, Coinbase…), so no vendor SDK or
 * WalletConnect project id is needed. See ADR-0004 for why not RainbowKit.
 */
export const wagmiConfig = createConfig({
  chains: [APP_CHAIN],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: { [APP_CHAIN.id]: http() },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
