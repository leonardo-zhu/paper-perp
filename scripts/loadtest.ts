/**
 * WebSocket fan-out load test.
 *
 *   pnpm loadtest -- --url ws://localhost:8787/ws --clients 200 --seconds 30
 *
 * Opens N clients, subscribes each to the book + trades channels and
 * measures delivery latency (gateway publish timestamp → client receive),
 * message rate, and the gateway's RSS before/after from /metrics.
 * Latency includes local loopback only, so run it on the same host or LAN.
 */
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:8787/ws' },
    clients: { type: 'string', default: '200' },
    seconds: { type: 'string', default: '30' },
    symbol: { type: 'string', default: 'BTC-PERP' },
  },
});
const url = values.url!;
const clients = Number(values.clients);
const seconds = Number(values.seconds);
const httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

async function rssMb(): Promise<number | null> {
  try {
    const text = await (await fetch(`${httpBase}/metrics`)).text();
    const m = /^process_resident_memory_bytes (\S+)/m.exec(text);
    return m ? Math.round(Number(m[1]) / 1024 / 1024) : null;
  } catch {
    return null;
  }
}

const latencies: number[] = [];
let messages = 0;
let gaps = 0;
let closed = 0;

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin: 'http://localhost:5173' } });
    let seq = -1;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          op: 'subscribe',
          channels: [`book:${values.symbol}`, `trades:${values.symbol}`],
        }),
      );
      resolve(ws);
    });
    ws.on('message', (raw) => {
      messages++;
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'book.snapshot') seq = msg.seq;
      if (msg.type === 'book.delta') {
        latencies.push(Date.now() - msg.ts);
        if (seq >= 0 && msg.prevSeq !== seq) gaps++;
        seq = msg.seq;
      }
    });
    ws.on('close', () => closed++);
    ws.on('error', reject);
  });
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

const rssBefore = await rssMb();
const t0 = Date.now();
const sockets: WebSocket[] = [];
for (let i = 0; i < clients; i += 50) {
  sockets.push(...(await Promise.all(Array.from({ length: Math.min(50, clients - i) }, open))));
}
console.log(
  `connected ${sockets.length} clients in ${Date.now() - t0}ms; measuring for ${seconds}s…`,
);
latencies.length = 0;
messages = 0;
await new Promise((r) => setTimeout(r, seconds * 1000));
const rssAfter = await rssMb();
for (const ws of sockets) ws.close();

const sorted = latencies.toSorted((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      clients: sockets.length,
      seconds,
      messagesPerSecond: Math.round(messages / seconds),
      bookDeltas: sorted.length,
      latencyMs: {
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        max: sorted.at(-1),
      },
      sequenceGaps: gaps,
      unexpectedCloses: closed - 0,
      gatewayRssMb: { before: rssBefore, after: rssAfter },
    },
    null,
    2,
  ),
);
process.exit(0);
