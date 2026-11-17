# ADR-0003: EIP-712 signed orders, replay protection and agent keys

- Status: accepted
- Date: 2026-11-17

## Context

On-chain perps (Hyperliquid, dYdX v4, Vertex) authorise every order with a
wallet signature rather than a password-backed session alone. The user
must be able to see what they sign, a signature must not be usable twice
or on another deployment/chain, and asking the wallet for every order is
poor UX.

## Decision

**Typed data.** Orders, cancels and agent approvals are EIP-712 messages
with domain `{ name: "PaperPerp", version: "1", chainId }`. Prices and
sizes are signed as integers scaled by 1e8 (`priceE8`, `sizeE8`) because
EIP-712 has no decimals (see ADR-0006). Each order carries a client order
id (`cloid`, bytes16), a `nonce` (uint64) and a `deadline` (uint64 seconds,
at most 5 minutes ahead).

**Verification.** The gateway requires a SIWE session whose address equals
`order.account`, checks the deadline window, recovers the signer with the
server's own chain id (a signature made for another chain recovers to an
unrelated address), and accepts the signer only if it is the account or an
approved, unexpired agent.

**Replay protection and idempotency.** `used_nonces(signer, nonce)` stores
the typed-data hash of the request that used it.

- Same nonce, same hash → the original order is returned (`200`,
  `duplicate: true`). Retries after a timeout are safe.
- Same nonce, different hash → `409 nonce_reused`.

The check, risk checks, matching and writes run in one synchronous
section inside one SQLite transaction, so concurrent duplicates cannot
both fill (covered by a test that submits the same order twice in
parallel).

**Agent keys.** The browser generates a key and the main wallet signs
`ApproveAgent { account, agent, validUntil, nonce }` once (max 7 days, the
UI uses 24 h). Orders and cancels signed by that key need no popup. Agents
cannot approve other agents; `validUntil = 0` revokes.

**SIWE.** Single-use server nonces (5 min), domain and URI must be in the
allow list (phishing guard), chain must match, `issuedAt` within 10 min,
expiration honoured, and the session is an opaque random id in an
`HttpOnly; SameSite=Lax` cookie (Secure in production).

## Consequences

- The agent private key lives in `localStorage`. An XSS bug could use it
  until it expires, but only to trade a paper account; it cannot move
  funds or approve other keys. A strict CSP (`script-src 'self'`) reduces
  the XSS surface. A production venue would keep it in a non-extractable
  WebCrypto key or an encrypted IndexedDB entry.
- Signature recovery supports EOAs only. Smart-contract wallets need
  ERC-1271/6492 verification through an RPC client; listed as future work.
- Nonces are per signer and millisecond-based with random low digits, so
  two tabs do not collide.
