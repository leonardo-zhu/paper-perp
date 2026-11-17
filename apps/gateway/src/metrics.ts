import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const m = {
    registry,
    httpDuration: new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    wsConnections: new client.Gauge({
      name: 'ws_connections',
      help: 'Open client WebSocket connections',
      registers: [registry],
    }),
    wsMessagesSent: new client.Counter({
      name: 'ws_messages_sent_total',
      help: 'Messages sent to WebSocket clients',
      labelNames: ['type'] as const,
      registers: [registry],
    }),
    wsSlowClientDrops: new client.Counter({
      name: 'ws_slow_client_drops_total',
      help: 'Clients disconnected because their send buffer exceeded the limit',
      registers: [registry],
    }),
    broadcastDuration: new client.Histogram({
      name: 'ws_broadcast_duration_seconds',
      help: 'Time to fan one message out to all subscribers',
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
      registers: [registry],
    }),
    upstreamMessages: new client.Counter({
      name: 'upstream_messages_total',
      help: 'Messages received from the market data venue',
      labelNames: ['venue', 'kind'] as const,
      registers: [registry],
    }),
    upstreamResyncs: new client.Counter({
      name: 'upstream_resyncs_total',
      help: 'Order book resyncs against the venue snapshot',
      labelNames: ['venue', 'reason'] as const,
      registers: [registry],
    }),
    upstreamReconnects: new client.Counter({
      name: 'upstream_reconnects_total',
      help: 'Upstream WebSocket reconnect attempts',
      labelNames: ['venue'] as const,
      registers: [registry],
    }),
    upstreamLag: new client.Histogram({
      name: 'upstream_event_lag_ms',
      help: 'Venue event time to gateway receive time',
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
      registers: [registry],
    }),
    marketLive: new client.Gauge({
      name: 'market_live',
      help: '1 when the market feed is live, 0 when stale or reconnecting',
      labelNames: ['symbol'] as const,
      registers: [registry],
    }),
    bookSeq: new client.Gauge({
      name: 'book_seq',
      help: 'Last published book sequence number',
      labelNames: ['symbol'] as const,
      registers: [registry],
    }),
    orders: new client.Counter({
      name: 'orders_total',
      help: 'Order requests by outcome',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    fills: new client.Counter({
      name: 'fills_total',
      help: 'Simulated fills',
      labelNames: ['liquidity'] as const,
      registers: [registry],
    }),
  };
  return m;
}

export type Metrics = ReturnType<typeof createMetrics>;
