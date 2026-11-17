# ADR-0005: Single gateway process with SQLite

- Status: accepted
- Date: 2026-11-17

## Context

The target deployment is one small ARM home server (NanoPi R4S, 4 GB RAM,
TF card) plus CI. The system needs atomic order processing, durable
sessions and orders, and simple operations.

## Decision

- One Node process hosts the venue adapters, WS hub, HTTP API and engine.
- Storage is SQLite through the built-in `node:sqlite` (no native addon),
  in WAL mode, with forward-only migrations applied on boot.
- Order processing is synchronous after signature recovery, inside
  `BEGIN IMMEDIATE … COMMIT`. Events are queued in an outbox and published
  after commit, so clients never see a fill that was rolled back.
- Rate limits are in-memory fixed windows (per IP for auth, per account for
  trading).

## Consequences

- No locks or distributed transactions are needed; the duplicate-order and
  double-fill guarantees come from the event loop plus one transaction.
- Measured footprint: ~125 MB RSS in production, ~170 MB with 1,000 WS
  clients.
- Horizontal scaling needs: Postgres, per-account locking for the critical
  section, Redis for rate limits, a separate fan-out tier, and matching
  sharded by symbol.
- Floating-point balances in SQLite are acceptable for paper money (see
  ADR-0006).
