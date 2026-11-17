# ADR-0001: Simulated matching on real market data

- Status: accepted
- Date: 2026-11-17

## Context

The goal is to practise the full production path of a trading front end:
wallet sign-in, signed orders, order lifecycle, real-time data, failure
handling, deployment and monitoring. Integrating a real exchange (or its
testnet) would make the backend a black box, put funds at risk, and make
it impossible to inject failures such as dropped connections, lost
messages or rejected orders on demand. Testnet faucets and availability
are also unreliable.

## Decision

- Market data comes from real public venues (Binance USDⓈ-M by default,
  Hyperliquid as an alternative, a deterministic mock for tests).
- Authentication (SIWE) and authorisation (EIP-712 signatures, agent keys)
  are real and verified server-side.
- Matching is simulated: taker orders walk the live book up to their limit
  or worst price; resting limits fill as maker when the live market
  crosses them. Each account starts with 10,000 paper USDC.

## Consequences

- The whole chain (sign → verify → replay check → risk → match → persist →
  push) is owned and testable, and faults can be injected through
  `/api/dev/fault`.
- Simulated fills do not consume upstream liquidity: two orders in quick
  succession can take the same level. Queue position for resting orders is
  not modelled (a crossed limit fills immediately at its price). Both are
  acceptable for paper trading and are documented in the UI footer.
- Leverage is fixed at 10x and there is no liquidation or funding; these
  are listed as future work.
- A `Venue` interface keeps the door open for a real execution adapter
  later.
