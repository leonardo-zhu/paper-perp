# ADR-0002: Gateway-owned order book sequencing (snapshot + delta)

- Status: accepted
- Date: 2026-11-17

## Context

Venues use different book protocols: Binance sends diff-depth events with
`U/u/pu` ids that must be stitched to a REST snapshot; Hyperliquid sends
full top-20 snapshots. Passing venue messages straight to browsers would
leak those details into the client, multiply bandwidth by the venue rate
(Binance ~10 msg/s per symbol, bursty), and make every upstream resync a
client-visible event.

## Decision

- The gateway keeps the full upstream book and publishes its own view:
  the top 25 levels per side.
- Every 100 ms, if the book changed, it diffs the new view against the last
  published one and emits `book.delta { epoch, prevSeq, seq, bids, asks }`
  (size 0 removes a level). On subscribe or `resync` it sends
  `book.snapshot { epoch, seq, … }`.
- Clients apply a delta only if `prevSeq` equals their `seq`. A gap, or a
  different `epoch` (gateway restarted), triggers `resync`.
- Liveness is explicit: `reconnecting`, `live`, `stale`. Trading is allowed
  only while `live`.

## Consequences

- Fan-out cost is bounded (≤ 10 deltas/s per symbol regardless of venue
  rate). Each message is serialised once and written to N sockets.
  Measured: 1,000 clients at p99 23 ms delivery latency on a laptop, no
  gaps.
- Upstream gaps are absorbed by the gateway: in the chaos drill the
  clients needed zero resyncs while the gateway resynced Binance 4 times.
- Coalescing adds up to 100 ms of latency, which is fine for a UI but not
  for algorithmic clients (they would need a raw feed).
- Clients only see 25 levels; deep-book features would need another
  channel.
