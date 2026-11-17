# Runbook

## Environments

| Env      | How it runs                                           | Market source                  | Notes                                                               |
| -------- | ----------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| dev      | `pnpm dev` (gateway on 8787, Vite on 5173 with proxy) | `binance` (or `pnpm dev:mock`) | Fault injection can be enabled in `apps/gateway/.env`.              |
| e2e / CI | Playwright starts gateway + Vite                      | `mock`                         | In-memory SQLite, fault injection on.                               |
| staging  | Same image as prod, `APP_ENV=staging`                 | `binance`                      | Fault injection allowed for chaos drills.                           |
| prod     | Single container behind a reverse proxy               | `binance`                      | `ENABLE_FAULT_INJECTION=false`, Secure cookies, `TRUST_PROXY=true`. |

All configuration is environment variables, validated with zod at boot
(`apps/gateway/src/config.ts`); the process refuses to start on invalid
values. See `.env.example`.

## Deploy

**Continuous deployment (default):** when CI passes on `main`,
`.github/workflows/deploy.yml` builds `ghcr.io/<owner>/paper-perp:<sha>` on a
native arm64 runner and pushes it, then a self-hosted runner labelled
`r4s` on the target host copies `deploy/single-host/compose.yaml` into
`/opt/stacks/paper-perp`, pulls with retries, runs `docker compose up -d`,
waits for `/readyz`, writes `IMAGE_REPO`/`IMAGE_TAG` into `.env` and keeps
the two most recent builds. It can also be run by hand (Actions → Deploy →
Run workflow). First-time host setup: create the directory, `.env` (see
below) and the data directory owned by uid 1000.

**Without a registry (home lab):**

```bash
DEPLOY_HOST=myserver DEPLOY_DIR=/opt/stacks/paper-perp ./scripts/deploy-ssh.sh
```

Builds `paperperp:<git sha>` locally for `linux/arm64` (override with
`PLATFORM`), streams it with `docker save | ssh docker load`, updates
`IMAGE_TAG` in the remote `.env` and runs `docker compose up -d`.

The remote directory needs `compose.yaml` (from `deploy/single-host/`) and
`.env`. Required in `.env` for a public deployment:

```
IMAGE_TAG=<sha>
PORT=3015
ALLOWED_ORIGINS=https://perp.example.com
SIWE_DOMAINS=perp.example.com
APP_ENV=prod
```

Reverse proxy: retry the upstream for ~20 s (`lb_try_duration` in Caddy) so the
few seconds of a container restart show up as a slow request instead of a
502, then forward everything (including WebSocket upgrades on `/ws`) to
`127.0.0.1:$PORT`, and block `/metrics` from the public internet (see
`deploy/Caddyfile`).

Migrations run on boot and are forward-only.

## Rollback

Old image tags stay on the host. Set `IMAGE_TAG` back to the previous sha
and `docker compose up -d`. The schema only ever gains tables or columns,
so an older binary keeps working against a newer database.

## Health and monitoring

| Endpoint       | Meaning                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` | Process is up (Docker healthcheck).                                                                                  |
| `GET /readyz`  | 200 once the DB answers and every market has received a snapshot; includes market status, venue and WS client count. |
| `GET /metrics` | Prometheus metrics (internal only).                                                                                  |

Key metrics: `market_live`, `upstream_messages_total`, `upstream_resyncs_total{reason}`,
`upstream_reconnects_total`, `upstream_event_lag_ms`, `ws_connections`,
`ws_broadcast_duration_seconds`, `ws_slow_client_drops_total`,
`orders_total{outcome}`, `fills_total{liquidity}`, `http_request_duration_seconds`,
plus Node defaults (RSS, event loop lag, GC).

`docker compose --profile monitoring up -d` starts Prometheus (with
`deploy/alerts.yml`) and Grafana (dashboard provisioned from
`deploy/grafana`).

Logs are JSON (pino) with `requestId`, `account`, `orderId` and `cloid`, so a
single order can be traced from HTTP request to fills. Session ids and
signatures are redacted. Errors that are not `AppError`s go to Sentry when
`SENTRY_DSN` / `VITE_SENTRY_DSN` are set.

## Alerts and what to do

| Alert                        | First checks                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MarketFeedNotLive`          | `/readyz` reason; container logs for `upstream error`; reachability of the venue from the host (`curl https://fapi.binance.com/fapi/v1/ping`). If the venue is blocked, switch `MARKET_SOURCE=hyperliquid` and `docker compose up -d`. Trading is already paused automatically. |
| `UpstreamResyncStorm`        | Packet loss to the venue or an overloaded event loop (`nodejs_eventloop_lag_p99_seconds`).                                                                                                                                                                                      |
| `SlowClientsDropped`         | One client on a bad network is normal; many means broadcast is too heavy. Check `ws_broadcast_duration_seconds`.                                                                                                                                                                |
| `HighApiLatency` / `Http5xx` | Logs filtered by `requestId`; SQLite lock contention (`busy_timeout`), disk full.                                                                                                                                                                                               |

## Chaos drill

```bash
ENABLE_FAULT_INJECTION=true pnpm --filter @paperperp/gateway dev
pnpm chaos -- --base http://localhost:8787 --rounds 3
```

Injects `disconnect`, `gap` (drop one depth event) and `freeze` (silence) and
reports time back to `live` and time until a client mirror matches the REST
snapshot. Last run against live Binance (2026-11-17, laptop):

| Fault      | Market status                           | Back to live      | Client book consistent after live |
| ---------- | --------------------------------------- | ----------------- | --------------------------------- |
| disconnect | reconnecting                            | ~1.2 s            | ~5 ms                             |
| gap        | stayed live (gateway resynced upstream) | —                 | ~5 ms, 0 client resyncs           |
| freeze 7 s | stale, trading paused                   | when data resumes | ~5 ms                             |

## Load test

```bash
pnpm loadtest -- --url ws://localhost:8787/ws --clients 1000 --seconds 20
```

Last run (2026-11-17, Apple Silicon laptop, live Binance feed, production build):

| Clients | Messages/s delivered | Delivery latency p50 / p95 / p99 | Sequence gaps | Gateway RSS |
| ------- | -------------------- | -------------------------------- | ------------- | ----------- |
| 200     | 2,322                | 3 / 6 / 8 ms                     | 0             | ~150–180 MB |
| 1,000   | 11,600               | 10 / 20 / 23 ms                  | 0             | ~170 MB     |

Latency is from the gateway publish timestamp to client receipt on the same
machine; it measures fan-out cost, not internet latency.
