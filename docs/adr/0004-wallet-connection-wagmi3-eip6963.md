# ADR-0004: Wallet connection with wagmi 3 and EIP-6963, no RainbowKit

- Status: accepted
- Date: 2026-11-17

## Context

The original plan used RainbowKit for the connect modal. At the time of
writing the latest RainbowKit (2.2.x) declares a peer dependency on
`wagmi ^2.9`, while wagmi is on 3.x. Reown AppKit supports wagmi 3 but
requires a Reown Cloud project id even for local development.

## Decision

Use wagmi 3 + viem directly with the `injected` connector and
`multiInjectedProviderDiscovery`. Every installed extension (MetaMask,
Rabby, OKX, Coinbase…) announces itself via EIP-6963 and appears in a
small custom picker. Signing uses the imperative `wagmi/actions` API
(`signMessage`, `signTypedData`, `switchChain`) so flows read top to
bottom.

## Consequences

- No vendor SDK, no project id, smaller bundle, and the app runs on the
  latest wagmi.
- No mobile/QR wallets until WalletConnect is added (needs a project id and
  `@walletconnect/ethereum-provider`).
- E2E tests can use a fake EIP-6963 wallet (`apps/web/e2e/test-wallet.ts`)
  that signs in Node with viem, exercising the real connector code path.
