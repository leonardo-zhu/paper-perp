# ADR-0006: Fixed-point at the signing boundary, floats inside

- Status: accepted
- Date: 2026-11-17

## Context

`0.1 + 0.2 !== 0.3` in JavaScript. Signatures must be byte-exact, and tick
and step validation must be exact (a price of `65000.15` with tick `0.1`
must be rejected, never rounded).

## Decision

- Prices and sizes cross the wire as decimal strings and are signed as
  `uint256` scaled by 1e8. Conversion goes through `bigint` (`toE8`,
  `fromE8`), never through floats.
- Tick and step checks are done on the scaled integers
  (`priceE8 % tickE8 === 0n`), both in the browser form and in the gateway.
- Inside the engine, sizes and prices are converted to numbers once
  validated; position sizes are rounded to the step decimals and PnL/fees
  to 6 decimals after each fill.

## Consequences

- Signing and validation are exact, and the browser and gateway can never
  disagree about what was signed.
- Accounting uses floats, which can drift by fractions of a micro-USDC over
  many fills. A real venue would keep integer units (or a decimal library)
  end to end; listed as future work.
