/**
 * Chaos drill: break the upstream feed on purpose and measure how long a
 * browser-like client takes to get back to a consistent book.
 *
 *   ENABLE_FAULT_INJECTION=true pnpm --filter @paperperp/gateway dev   # in another shell
 *   pnpm chaos -- --base http://localhost:8787 --rounds 3
 *
 * For each fault (disconnect, gap, freeze) the client mirrors the book the
 * same way the web app does (snapshot + sequenced deltas, resync on gap),
 * then we record:
 *   - time until market status is `live` again
 *   - time until the mirror equals the gateway's REST snapshot
 */
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { OrderBook, viewsEqual } from '../packages/shared/src/orderbook';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:8787' },
    rounds: { type: 'string', default: '3' },
    symbol: { type: 'string', default: 'BTC-PERP' },
  },
});
const base = values.base!;
const symbol = values.symbol!;
const DEPTH = 25;

const mirror = new OrderBook();
let status = 'reconnecting';
let epoch = '';
let clientResyncs = 0;

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, {
  headers: { origin: 'http://localhost:5173' },
});
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ op: 'subscribe', channels: [`book:${symbol}`] }));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'market.status') status = msg.status;
  if (msg.type === 'book.snapshot') {
    epoch = msg.epoch;
    mirror.applySnapshot(msg.seq, msg.bids, msg.asks);
  }
  if (msg.type === 'book.delta') {
    const r =
      msg.epoch !== epoch ? 'gap' : mirror.applyDelta(msg.prevSeq, msg.seq, msg.bids, msg.asks);
    if (r === 'gap' || r === 'uninitialized') {
      clientResyncs++;
      ws.send(JSON.stringify({ op: 'resync', symbol }));
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function consistent(): Promise<boolean> {
  const snap = (await (await fetch(`${base}/api/markets/${symbol}/book`)).json()) as {
    seq: number;
    bids: [number, number][];
    asks: [number, number][];
  };
  return (
    snap.seq === mirror.seq && viewsEqual(mirror.top(DEPTH), { bids: snap.bids, asks: snap.asks })
  );
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return Date.now() - start;
    await sleep(50);
  }
  return null;
}

await waitFor(() => status === 'live', 15_000);
const results: Record<string, unknown>[] = [];
for (let round = 1; round <= Number(values.rounds); round++) {
  for (const kind of ['disconnect', 'gap', 'freeze'] as const) {
    const res = await fetch(`${base}/api/dev/fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ kind, ms: 7_000 }),
    });
    if (!res.ok)
      throw new Error(
        `fault injection failed (${res.status}); start the gateway with ENABLE_FAULT_INJECTION=true`,
      );
    const t0 = Date.now();
    await sleep(kind === 'freeze' ? 6_000 : 300); // let the fault bite
    const wentDown = status !== 'live';
    const toLive = await waitFor(() => status === 'live', 60_000);
    const toConsistent = await waitFor(consistent, 30_000);
    results.push({
      round,
      kind,
      statusLeftLive: wentDown,
      msToLive: toLive === null ? 'timeout' : Date.now() - t0 - (toConsistent ?? 0),
      msToConsistentBookAfterLive: toConsistent ?? 'timeout',
    });
    await sleep(2_000);
  }
}
console.table(results);
console.log({ clientResyncs, finalSeq: mirror.seq });
ws.close();
process.exit(0);
