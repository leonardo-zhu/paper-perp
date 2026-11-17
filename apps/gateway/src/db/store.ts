import type { FillDTO, OrderDTO, OrderStatus, Side } from '@paperperp/shared';
import type { Address } from 'viem';
import type { Database } from './sqlite';

export interface SessionRow {
  id: string;
  address: Address;
  chainId: number;
  expiresAt: number;
}

export interface PositionRow {
  account: Address;
  symbol: string;
  size: number;
  entryPrice: number;
  realizedPnl: number;
}

export interface UsedNonce {
  kind: string;
  requestHash: string;
  ref: string | null;
}

type Row = Record<string, unknown>;

/** Thin data-access layer over SQLite. All methods are synchronous. */
export class Store {
  private inTx = false;

  constructor(readonly db: Database) {}

  /**
   * Run `fn` atomically. node:sqlite is synchronous, so a transaction can never
   * interleave with another request on the event loop.
   */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  ping(): boolean {
    return this.db.prepare('SELECT 1 AS ok').get() !== undefined;
  }

  // ---- SIWE nonces & sessions ----

  createSiweNonce(nonce: string, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO siwe_nonces (nonce, expires_at) VALUES (?, ?)')
      .run(nonce, expiresAt);
  }

  /** Single use: returns true only the first time an unexpired nonce is consumed. */
  consumeSiweNonce(nonce: string, now: number): boolean {
    const res = this.db
      .prepare('DELETE FROM siwe_nonces WHERE nonce = ? AND expires_at > ?')
      .run(nonce, now);
    return Number(res.changes) === 1;
  }

  createSession(s: SessionRow, now: number): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id, address, chain_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(s.id, s.address, s.chainId, now, s.expiresAt);
  }

  getSession(id: string, now: number): SessionRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?')
      .get(id, now) as Row | undefined;
    return r
      ? {
          id: r.id as string,
          address: r.address as Address,
          chainId: r.chain_id as number,
          expiresAt: r.expires_at as number,
        }
      : undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  purgeExpired(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM siwe_nonces WHERE expires_at <= ?').run(now);
  }

  // ---- accounts ----

  ensureAccount(address: Address, startingBalance: number, now: number): void {
    this.db
      .prepare(
        'INSERT INTO accounts (address, balance, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .run(address, startingBalance, now);
  }

  getBalance(address: Address): number | undefined {
    const r = this.db.prepare('SELECT balance FROM accounts WHERE address = ?').get(address) as
      | Row
      | undefined;
    return r ? (r.balance as number) : undefined;
  }

  addBalance(address: Address, delta: number): void {
    this.db
      .prepare('UPDATE accounts SET balance = balance + ? WHERE address = ?')
      .run(delta, address);
  }

  resetAccount(address: Address, balance: number): void {
    this.tx(() => {
      this.db.prepare('UPDATE accounts SET balance = ? WHERE address = ?').run(balance, address);
      this.db.prepare('DELETE FROM positions WHERE account = ?').run(address);
      this.db.prepare('DELETE FROM fills WHERE account = ?').run(address);
      this.db.prepare('DELETE FROM orders WHERE account = ?').run(address);
    });
  }

  // ---- agents ----

  upsertAgent(account: Address, agent: Address, validUntil: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO agents (account, agent, valid_until, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account, agent) DO UPDATE SET valid_until = excluded.valid_until, updated_at = excluded.updated_at`,
      )
      .run(account, agent, validUntil, now);
  }

  /** validUntil in ms, or undefined when the agent was never approved. */
  getAgentValidUntil(account: Address, agent: Address): number | undefined {
    const r = this.db
      .prepare('SELECT valid_until FROM agents WHERE account = ? AND agent = ?')
      .get(account, agent) as Row | undefined;
    return r ? (r.valid_until as number) : undefined;
  }

  listAgents(account: Address, now: number): { agent: Address; validUntil: number }[] {
    return (
      this.db
        .prepare('SELECT agent, valid_until FROM agents WHERE account = ? AND valid_until > ?')
        .all(account, now) as Row[]
    ).map((r) => ({ agent: r.agent as Address, validUntil: r.valid_until as number }));
  }

  // ---- replay protection ----

  getUsedNonce(signer: Address, nonce: bigint): UsedNonce | undefined {
    const r = this.db
      .prepare('SELECT kind, request_hash, ref FROM used_nonces WHERE signer = ? AND nonce = ?')
      .get(signer, nonce.toString()) as Row | undefined;
    return r
      ? {
          kind: r.kind as string,
          requestHash: r.request_hash as string,
          ref: r.ref as string | null,
        }
      : undefined;
  }

  insertUsedNonce(
    signer: Address,
    nonce: bigint,
    kind: string,
    requestHash: string,
    ref: string | null,
    now: number,
  ): void {
    this.db
      .prepare(
        'INSERT INTO used_nonces (signer, nonce, kind, request_hash, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(signer, nonce.toString(), kind, requestHash, ref, now);
  }

  // ---- orders ----

  insertOrder(o: OrderDTO): void {
    this.db
      .prepare(
        `INSERT INTO orders (id, account, signer, cloid, symbol, side, type, price, size, filled_size,
          avg_fill_price, reduce_only, status, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id,
        o.account,
        o.signer,
        o.cloid,
        o.symbol,
        o.side,
        o.type,
        o.price,
        o.size,
        o.filledSize,
        o.avgFillPrice,
        o.reduceOnly ? 1 : 0,
        o.status,
        o.reason,
        o.createdAt,
        o.updatedAt,
      );
  }

  updateOrder(o: OrderDTO): void {
    this.db
      .prepare(
        'UPDATE orders SET filled_size = ?, avg_fill_price = ?, status = ?, reason = ?, updated_at = ? WHERE id = ?',
      )
      .run(o.filledSize, o.avgFillPrice, o.status, o.reason, o.updatedAt, o.id);
  }

  getOrder(id: string): OrderDTO | undefined {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
    return r ? toOrder(r) : undefined;
  }

  getOrderByCloid(account: Address, cloid: string): OrderDTO | undefined {
    const r = this.db
      .prepare('SELECT * FROM orders WHERE account = ? AND cloid = ?')
      .get(account, cloid) as Row | undefined;
    return r ? toOrder(r) : undefined;
  }

  listOrders(account: Address, limit: number): OrderDTO[] {
    return (
      this.db
        .prepare('SELECT * FROM orders WHERE account = ? ORDER BY created_at DESC LIMIT ?')
        .all(account, limit) as Row[]
    ).map(toOrder);
  }

  listWorkingOrders(): OrderDTO[] {
    return (
      this.db
        .prepare("SELECT * FROM orders WHERE status IN ('open', 'partially_filled')")
        .all() as Row[]
    ).map(toOrder);
  }

  // ---- fills & positions ----

  insertFill(f: FillDTO & { account: Address }): void {
    this.db
      .prepare(
        `INSERT INTO fills (id, order_id, account, cloid, symbol, side, price, size, fee, liquidity, realized_pnl, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.id,
        f.orderId,
        f.account,
        f.cloid,
        f.symbol,
        f.side,
        f.price,
        f.size,
        f.fee,
        f.liquidity,
        f.realizedPnl,
        f.ts,
      );
  }

  listFills(account: Address, limit: number): FillDTO[] {
    return (
      this.db
        .prepare('SELECT * FROM fills WHERE account = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
        .all(account, limit) as Row[]
    ).map((r) => ({
      id: r.id as string,
      orderId: r.order_id as string,
      cloid: r.cloid as string,
      symbol: r.symbol as string,
      side: r.side as Side,
      price: r.price as number,
      size: r.size as number,
      fee: r.fee as number,
      liquidity: r.liquidity as 'maker' | 'taker',
      realizedPnl: r.realized_pnl as number,
      ts: r.ts as number,
    }));
  }

  getPosition(account: Address, symbol: string): PositionRow {
    const r = this.db
      .prepare('SELECT * FROM positions WHERE account = ? AND symbol = ?')
      .get(account, symbol) as Row | undefined;
    return r ? toPosition(r) : { account, symbol, size: 0, entryPrice: 0, realizedPnl: 0 };
  }

  savePosition(p: PositionRow): void {
    this.db
      .prepare(
        `INSERT INTO positions (account, symbol, size, entry_price, realized_pnl) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account, symbol) DO UPDATE SET size = excluded.size,
           entry_price = excluded.entry_price, realized_pnl = excluded.realized_pnl`,
      )
      .run(p.account, p.symbol, p.size, p.entryPrice, p.realizedPnl);
  }

  listPositions(account: Address): PositionRow[] {
    return (this.db.prepare('SELECT * FROM positions WHERE account = ?').all(account) as Row[]).map(
      toPosition,
    );
  }
}

function toOrder(r: Row): OrderDTO {
  return {
    id: r.id as string,
    account: r.account as Address,
    signer: r.signer as Address,
    cloid: r.cloid as string,
    symbol: r.symbol as string,
    side: r.side as Side,
    type: r.type as 'limit' | 'market',
    price: r.price as number,
    size: r.size as number,
    filledSize: r.filled_size as number,
    avgFillPrice: (r.avg_fill_price as number | null) ?? null,
    reduceOnly: r.reduce_only === 1,
    status: r.status as OrderStatus,
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toPosition(r: Row): PositionRow {
  return {
    account: r.account as Address,
    symbol: r.symbol as string,
    size: r.size as number,
    entryPrice: r.entry_price as number,
    realizedPnl: r.realized_pnl as number,
  };
}
