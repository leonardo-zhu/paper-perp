import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type ClientMessage,
  channels,
  HEARTBEAT_INTERVAL_MS,
  isMarketSymbol,
  type ServerMessage,
} from '@paperperp/shared';
import type { Address } from 'viem';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Logger } from '../logger';
import type { Publisher } from '../market/market-service';
import type { Metrics } from '../metrics';

/** A client whose unsent buffer grows past this is too slow to keep up; drop it. */
const MAX_BUFFERED_BYTES = 1 << 20;
const MAX_SUBSCRIPTIONS = 20;

interface Client {
  id: string;
  ws: WebSocket;
  ip: string;
  account: Address | null;
  subs: Set<string>;
  lastSeen: number;
}

export interface HubDeps {
  log: Logger;
  metrics: Metrics;
  epoch: string;
  allowedOrigins: string[];
  /** Resolve the SIWE session from the upgrade request's cookie. */
  authenticate(req: IncomingMessage): Address | null;
  /** Initial messages sent right after subscribing to a channel. */
  initialMessages(channel: string, account: Address | null): ServerMessage[];
  clientIp(req: IncomingMessage): string;
}

export class Hub implements Publisher {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly byChannel = new Map<string, Set<Client>>();
  private readonly byAccount = new Map<Address, Set<Client>>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HubDeps) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_INTERVAL_MS);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Serialise once, fan out to every subscriber. */
  publish(channel: string, msg: ServerMessage): void {
    const subs = this.byChannel.get(channel);
    if (!subs?.size) return;
    const end = this.deps.metrics.broadcastDuration.startTimer();
    const data = JSON.stringify(msg);
    for (const c of subs) this.sendRaw(c, data);
    this.deps.metrics.wsMessagesSent.inc({ type: msg.type }, subs.size);
    end();
  }

  sendToAccount(account: Address, msg: ServerMessage): void {
    const subs = this.byAccount.get(account);
    if (!subs?.size) return;
    const data = JSON.stringify(msg);
    for (const c of subs) if (c.subs.has(channels.account)) this.sendRaw(c, data);
    this.deps.metrics.wsMessagesSent.inc({ type: msg.type }, subs.size);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.close(1001, 'server shutting down');
    this.wss.close();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Cross-site WebSocket hijacking guard: browsers always send Origin, and
    // cookies ride along on the upgrade, so an unknown origin must be refused.
    const origin = req.headers.origin;
    if (origin && !this.deps.allowedOrigins.includes(origin)) {
      this.deps.log.warn({ origin }, 'ws upgrade from disallowed origin');
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = {
      id: randomUUID().slice(0, 8),
      ws,
      ip: this.deps.clientIp(req),
      account: this.deps.authenticate(req),
      subs: new Set(),
      lastSeen: Date.now(),
    };
    this.clients.add(client);
    if (client.account) this.index(this.byAccount, client.account, client);
    this.deps.metrics.wsConnections.set(this.clients.size);

    ws.on('message', (raw) => {
      client.lastSeen = Date.now();
      this.onMessage(client, raw.toString());
    });
    ws.on('pong', () => {
      client.lastSeen = Date.now();
    });
    ws.on('close', () => this.remove(client));
    ws.on('error', () => this.remove(client));

    this.send(client, {
      type: 'hello',
      epoch: this.deps.epoch,
      serverTime: Date.now(),
      authenticated: client.account !== null,
    });
  }

  private onMessage(client: Client, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.error(client, 'invalid_request', 'malformed JSON');
      return;
    }
    switch (msg.op) {
      case 'ping':
        this.send(client, { type: 'pong', ts: Number(msg.ts) || 0, serverTime: Date.now() });
        break;
      case 'subscribe':
        this.subscribe(client, Array.isArray(msg.channels) ? msg.channels : []);
        break;
      case 'unsubscribe':
        for (const ch of Array.isArray(msg.channels) ? msg.channels : []) {
          this.unsubscribe(client, ch);
        }
        break;
      case 'resync': {
        const ch = channels.book(String(msg.symbol));
        if (!client.subs.has(ch)) {
          this.error(client, 'invalid_request', 'not subscribed');
          break;
        }
        for (const m of this.deps.initialMessages(ch, client.account)) this.send(client, m);
        break;
      }
      default:
        this.error(client, 'invalid_request', 'unknown op');
    }
  }

  private subscribe(client: Client, list: unknown[]): void {
    const added: string[] = [];
    for (const ch of list) {
      if (typeof ch !== 'string' || !isValidChannel(ch)) {
        this.error(client, 'invalid_request', `unknown channel ${String(ch)}`);
        continue;
      }
      if (ch === channels.account && !client.account) {
        this.error(client, 'unauthorized', 'sign in to subscribe to account updates');
        continue;
      }
      if (client.subs.has(ch)) continue;
      if (client.subs.size >= MAX_SUBSCRIPTIONS) {
        this.error(client, 'invalid_request', 'too many subscriptions');
        break;
      }
      client.subs.add(ch);
      this.index(this.byChannel, ch, client);
      added.push(ch);
    }
    if (!added.length) return;
    this.send(client, { type: 'subscribed', channels: added });
    for (const ch of added) {
      for (const m of this.deps.initialMessages(ch, client.account)) this.send(client, m);
    }
  }

  private unsubscribe(client: Client, ch: string): void {
    client.subs.delete(ch);
    this.byChannel.get(ch)?.delete(client);
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const ch of client.subs) this.byChannel.get(ch)?.delete(client);
    if (client.account) this.byAccount.get(client.account)?.delete(client);
    this.deps.metrics.wsConnections.set(this.clients.size);
  }

  private send(client: Client, msg: ServerMessage): void {
    this.sendRaw(client, JSON.stringify(msg));
  }

  private sendRaw(client: Client, data: string): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.deps.metrics.wsSlowClientDrops.inc();
      this.deps.log.warn({ client: client.id, ip: client.ip }, 'dropping slow ws client');
      client.ws.terminate();
      this.remove(client);
      return;
    }
    client.ws.send(data);
  }

  private error(client: Client, code: string, message: string): void {
    this.send(client, { type: 'error', code, message });
  }

  /** Drop clients that stopped answering; ping the rest (keeps proxies/NATs open). */
  private sweep(): void {
    const deadline = Date.now() - HEARTBEAT_INTERVAL_MS * 3;
    for (const c of this.clients) {
      if (c.lastSeen < deadline) {
        c.ws.terminate();
        this.remove(c);
      } else {
        c.ws.ping();
      }
    }
  }

  private index<K>(map: Map<K, Set<Client>>, key: K, client: Client): void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(client);
  }
}

function isValidChannel(ch: string): boolean {
  if (ch === channels.account || ch === channels.tickers) return true;
  const [kind, symbol, interval] = ch.split(':');
  if (!symbol || !isMarketSymbol(symbol)) return false;
  if (kind === 'book' || kind === 'trades') return interval === undefined;
  return kind === 'kline' && interval === '1m';
}
