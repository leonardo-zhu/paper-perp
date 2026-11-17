import {
  type ApproveAgentMessage,
  approveAgentTypedData,
  type CancelMessage,
  cancelTypedData,
  type MarketStatus,
  OrderBook,
  type OrderMessage,
  orderTypedData,
  toE8,
  toWire,
} from '@paperperp/shared';
import { type Hex, toHex } from 'viem';
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { AuthService } from '../auth/auth-service';
import { loadConfig } from '../config';
import { openDatabase } from '../db/sqlite';
import { Store } from '../db/store';
import { createApp } from '../http/app';
import { createLogger } from '../logger';
import { createMetrics } from '../metrics';
import { TradingEngine } from '../trading/engine';

export const CHAIN_ID = 421614;
export const ORIGIN = 'http://localhost:5173';

/** In-memory market the tests can move by hand. */
export class FakeMarket {
  readonly book = new OrderBook();
  statusValue: MarketStatus = 'live';
  readonly venueName = 'fake';
  readonly epoch = 'test';

  constructor() {
    this.setBook(
      [
        [64_999.9, 1],
        [64_999, 2],
      ],
      [
        [65_000.1, 0.5],
        [65_001, 2],
      ],
    );
  }

  setBook(bids: [number, number][], asks: [number, number][]) {
    this.book.applySnapshot(0, bids, asks);
  }
  status() {
    return this.statusValue;
  }
  mid() {
    return this.book.mid();
  }
  snapshotMessage() {
    return {
      type: 'book.snapshot' as const,
      symbol: 'BTC-PERP',
      epoch: 'test',
      seq: 0,
      bids: [],
      asks: [],
      ts: 0,
    };
  }
  candles() {
    return [];
  }
  injectFault() {}
}

export function createHarness() {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    CHAIN_ID: String(CHAIN_ID),
  });
  const log = createLogger(cfg);
  const metrics = createMetrics();
  const store = new Store(openDatabase(':memory:'));
  const market = new FakeMarket();
  const events: { type: string; payload: unknown }[] = [];
  const auth = new AuthService(store, {
    chainId: CHAIN_ID,
    siweDomains: cfg.SIWE_DOMAINS,
    allowedOrigins: cfg.ALLOWED_ORIGINS,
    sessionTtlMs: 3_600_000,
  });
  const engine = new TradingEngine({
    store,
    market: { status: () => market.status(), book: () => market.book, mid: () => market.mid() },
    chainId: CHAIN_ID,
    log,
    metrics,
    events: {
      order: (o) => events.push({ type: 'order', payload: o }),
      fill: (_a, f) => events.push({ type: 'fill', payload: f }),
      position: (_a, p) => events.push({ type: 'position', payload: p }),
      account: (a) => events.push({ type: 'account', payload: a }),
    },
  });
  const app = createApp({
    cfg,
    log,
    metrics,
    store,
    auth,
    engine,
    market: market as never,
    wsClients: () => 0,
    clientIp: () => '127.0.0.1',
  });

  async function request(
    path: string,
    init: { method?: string; body?: unknown; cookie?: string } = {},
  ) {
    const res = await app.request(path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return {
      status: res.status,
      // biome-ignore lint/suspicious/noExplicitAny: tests poke into arbitrary JSON
      body: (await res.json()) as Record<string, any>,
      headers: res.headers,
    };
  }

  async function siweMessage(
    account: PrivateKeyAccount,
    overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {},
  ) {
    const { body } = await request('/api/auth/nonce');
    return createSiweMessage({
      address: account.address,
      chainId: CHAIN_ID,
      domain: 'localhost:5173',
      uri: ORIGIN,
      version: '1',
      nonce: body.nonce,
      issuedAt: new Date(),
      statement: 'Sign in to PaperPerp',
      ...overrides,
    });
  }

  async function login(account: PrivateKeyAccount): Promise<string> {
    const message = await siweMessage(account);
    const signature = await account.signMessage({ message });
    const res = await request('/api/auth/verify', { body: { message, signature } });
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    return cookie;
  }

  return { app, store, market, engine, events, request, login, siweMessage };
}

export function newAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

let nonceCounter = BigInt(Date.now());
export const nextNonce = () => ++nonceCounter;
export const deadline = (inSec = 60) => BigInt(Math.floor(Date.now() / 1000) + inSec);
export const randomCloid = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(16)));

export function makeOrder(
  account: PrivateKeyAccount,
  o: Partial<OrderMessage> & { price?: string; size?: string } = {},
): OrderMessage {
  const { price = '65010', size = '0.1', ...rest } = o;
  return {
    account: account.address,
    symbol: 'BTC-PERP',
    isBuy: true,
    orderType: 1,
    priceE8: toE8(price),
    sizeE8: toE8(size),
    reduceOnly: false,
    cloid: randomCloid(),
    nonce: nextNonce(),
    deadline: deadline(),
    ...rest,
  };
}

export async function signedOrder(
  signer: PrivateKeyAccount,
  order: OrderMessage,
  chainId = CHAIN_ID,
) {
  const signature = await signer.signTypedData(orderTypedData(chainId, order));
  return { order: toWire(order), signature };
}

export async function signedCancel(signer: PrivateKeyAccount, cancel: CancelMessage) {
  const signature = await signer.signTypedData(cancelTypedData(CHAIN_ID, cancel));
  return { cancel: toWire(cancel), signature };
}

export async function signedApproval(signer: PrivateKeyAccount, approval: ApproveAgentMessage) {
  const signature = await signer.signTypedData(approveAgentTypedData(CHAIN_ID, approval));
  return { approval: toWire(approval), signature };
}
