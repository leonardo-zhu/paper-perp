import { randomUUID } from 'node:crypto';
import {
  type AccountDTO,
  type AgentDTO,
  type ApproveAgentMessage,
  approveAgentTypedData,
  type CancelMessage,
  cancelTypedData,
  decimalsOf,
  e8ToNumber,
  type FillDTO,
  getMarket,
  isMarketSymbol,
  isWorking,
  MAKER_FEE_RATE,
  MAX_AGENT_VALIDITY_SEC,
  MAX_ORDER_TTL_SEC,
  type MarketStatus,
  type MarketSymbol,
  nextStatus,
  type OrderBook,
  type OrderDTO,
  type OrderEvent,
  type OrderMessage,
  orderTypedData,
  type PlaceOrderResponse,
  type PositionDTO,
  round,
  type ServerMessage,
  TAKER_FEE_RATE,
  toE8,
} from '@paperperp/shared';
import {
  type Address,
  getAddress,
  type Hex,
  hashTypedData,
  recoverTypedDataAddress,
  type TypedDataDefinition,
} from 'viem';
import type { SessionRow, Store } from '../db/store';
import { AppError } from '../errors';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import { applyFill, planFills } from './matching';

/** Allowed clock skew when checking deadlines (seconds). */
const CLOCK_SKEW_SEC = 30;
const EPSILON = 1e-9;

export interface MarketView {
  status(symbol: MarketSymbol): MarketStatus;
  book(symbol: MarketSymbol): OrderBook;
  mid(symbol: MarketSymbol): number | undefined;
}

export interface EngineEvents {
  order(order: OrderDTO): void;
  fill(account: Address, fill: FillDTO): void;
  position(account: Address, position: PositionDTO): void;
  account(account: AccountDTO): void;
}

interface EngineDeps {
  store: Store;
  market: MarketView;
  events: EngineEvents;
  chainId: number;
  log: Logger;
  metrics: Metrics;
  now?: () => number;
}

type Outbox = (() => void)[];

/**
 * Order entry, risk checks and simulated matching.
 *
 * Every request is split into an async part (signature recovery, pure CPU)
 * and a synchronous critical section (nonce check → risk → match → persist)
 * that runs inside one SQLite transaction. Node runs that section without
 * interleaving, so two copies of the same signed order can never both fill.
 * Events are queued in an outbox and published only after commit.
 */
export class TradingEngine {
  private readonly working = new Map<string, OrderDTO>();
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    for (const o of deps.store.listWorkingOrders()) this.working.set(o.id, o);
  }

  // ---------------------------------------------------------------- orders

  async placeOrder(
    session: SessionRow,
    body: { order: OrderMessage; signature: Hex; chainId?: number },
  ): Promise<PlaceOrderResponse> {
    const { store, metrics } = this.deps;
    const msg: OrderMessage = { ...body.order, account: getAddress(body.order.account) };
    this.assertSessionAccount(session, msg.account, body.chainId);
    if (!isMarketSymbol(msg.symbol)) throw new AppError('unknown_market');
    this.assertDeadline(msg.deadline);

    const typed = orderTypedData(this.deps.chainId, msg);
    const signer = await recoverSigner(typed, body.signature);
    this.assertAuthorized(msg.account, signer);
    const requestHash = hashTypedData(typed);

    // ---- synchronous critical section ----
    const used = store.getUsedNonce(signer, msg.nonce);
    if (used) {
      const existing = used.ref ? store.getOrder(used.ref) : undefined;
      if (used.requestHash === requestHash && existing) {
        metrics.orders.inc({ outcome: 'duplicate' });
        return { order: existing, fills: [], duplicate: true };
      }
      metrics.orders.inc({ outcome: 'nonce_reused' });
      throw new AppError('nonce_reused');
    }

    const symbol = msg.symbol;
    const market = getMarket(symbol);
    const invalid = validateOrderParams(msg);
    if (invalid) throw new AppError('invalid_order', invalid);
    if (store.getOrderByCloid(msg.account, msg.cloid)) {
      throw new AppError('invalid_order', 'cloid already used for another order');
    }

    const now = this.now();
    const order: OrderDTO = {
      id: randomUUID(),
      cloid: msg.cloid,
      account: msg.account,
      signer,
      symbol,
      side: msg.isBuy ? 'buy' : 'sell',
      type: msg.orderType === 1 ? 'market' : 'limit',
      price: e8ToNumber(msg.priceE8),
      size: e8ToNumber(msg.sizeE8),
      filledSize: 0,
      avgFillPrice: null,
      reduceOnly: msg.reduceOnly,
      status: 'pending',
      reason: null,
      createdAt: now,
      updatedAt: now,
    };

    const outbox: Outbox = [];
    const fills: FillDTO[] = [];
    const rejection = this.riskCheck(order, market.priceBandPct, market.maxLeverage);

    store.tx(() => {
      store.insertOrder(order);
      store.insertUsedNonce(signer, msg.nonce, 'order', requestHash, order.id, now);
      if (rejection) {
        this.transition(order, 'reject', rejection);
        store.updateOrder(order);
      } else {
        this.execute(order, 'taker', fills, outbox);
      }
    });
    outbox.push(() => this.deps.events.order(order));
    this.flush(outbox);

    metrics.orders.inc({ outcome: rejection ?? order.status });
    this.deps.log.info(
      {
        orderId: order.id,
        account: order.account,
        cloid: order.cloid,
        status: order.status,
        reason: order.reason,
      },
      'order processed',
    );
    if (rejection) throw new AppError(rejection, undefined, undefined, { order });
    return { order, fills, duplicate: false };
  }

  async cancelOrder(
    session: SessionRow,
    body: { cancel: CancelMessage; signature: Hex; chainId?: number },
  ): Promise<OrderDTO> {
    const { store } = this.deps;
    const msg: CancelMessage = { ...body.cancel, account: getAddress(body.cancel.account) };
    this.assertSessionAccount(session, msg.account, body.chainId);
    this.assertDeadline(msg.deadline);
    const typed = cancelTypedData(this.deps.chainId, msg);
    const signer = await recoverSigner(typed, body.signature);
    this.assertAuthorized(msg.account, signer);
    const requestHash = hashTypedData(typed);

    const used = store.getUsedNonce(signer, msg.nonce);
    if (used) {
      const existing = used.ref ? store.getOrder(used.ref) : undefined;
      if (used.requestHash === requestHash && existing) return existing;
      throw new AppError('nonce_reused');
    }
    const order = store.getOrderByCloid(msg.account, msg.cloid);
    if (!order) throw new AppError('order_not_found');
    const live = this.working.get(order.id) ?? order;
    if (!isWorking(live.status)) throw new AppError('order_not_open');

    const outbox: Outbox = [];
    store.tx(() => {
      store.insertUsedNonce(signer, msg.nonce, 'cancel', requestHash, live.id, this.now());
      this.transition(live, 'cancel', 'canceled_by_user');
      store.updateOrder(live);
      this.working.delete(live.id);
      outbox.push(() => this.deps.events.order(live));
      this.queueAccount(live.account, outbox);
    });
    this.flush(outbox);
    return live;
  }

  // ---------------------------------------------------------------- agents

  /**
   * Agent ("API wallet") approval: the main wallet signs once to let a
   * browser-generated key trade for it until `validUntil`. Orders signed by
   * the agent need no wallet popup; the agent can never approve other agents.
   */
  async approveAgent(
    session: SessionRow,
    body: { approval: ApproveAgentMessage; signature: Hex; chainId?: number },
  ): Promise<AgentDTO> {
    const { store } = this.deps;
    const msg: ApproveAgentMessage = {
      ...body.approval,
      account: getAddress(body.approval.account),
      agent: getAddress(body.approval.agent),
    };
    this.assertSessionAccount(session, msg.account, body.chainId);
    const nowSec = Math.floor(this.now() / 1000);
    const validUntil = Number(msg.validUntil);
    const revoke = validUntil === 0;
    if (!revoke && (validUntil <= nowSec || validUntil > nowSec + MAX_AGENT_VALIDITY_SEC)) {
      throw new AppError('invalid_request', 'agent validity must be within 7 days');
    }
    if (msg.agent === msg.account)
      throw new AppError('invalid_request', 'agent must differ from account');

    const typed = approveAgentTypedData(this.deps.chainId, msg);
    const signer = await recoverSigner(typed, body.signature);
    if (signer !== msg.account)
      throw new AppError('signer_not_authorized', 'only the account owner can approve agents');
    const requestHash = hashTypedData(typed);

    const used = store.getUsedNonce(signer, msg.nonce);
    if (used && used.requestHash !== requestHash) throw new AppError('nonce_reused');
    if (!used) {
      store.tx(() => {
        store.insertUsedNonce(signer, msg.nonce, 'approve_agent', requestHash, null, this.now());
        store.upsertAgent(msg.account, msg.agent, revoke ? 0 : validUntil * 1000, this.now());
      });
    }
    return { agent: msg.agent, validUntil: revoke ? 0 : validUntil * 1000 };
  }

  listAgents(account: Address): AgentDTO[] {
    return this.deps.store.listAgents(account, this.now());
  }

  // ---------------------------------------------------------------- matching of resting orders

  /** Called after every published book change: fill resting limit orders the market crossed. */
  onBookChange(symbol: MarketSymbol): void {
    if (this.deps.market.status(symbol) !== 'live') return;
    const book = this.deps.market.book(symbol);
    const bestBid = book.bestBid();
    const bestAsk = book.bestAsk();
    for (const order of this.working.values()) {
      if (order.symbol !== symbol) continue;
      const crossed =
        order.side === 'buy'
          ? bestAsk !== undefined && bestAsk <= order.price
          : bestBid !== undefined && bestBid >= order.price;
      if (!crossed) continue;
      const outbox: Outbox = [];
      this.deps.store.tx(() => {
        const before = order.filledSize;
        this.execute(order, 'maker', [], outbox);
        if (order.filledSize !== before || !isWorking(order.status)) {
          outbox.push(() => this.deps.events.order(order));
        }
      });
      this.flush(outbox);
    }
  }

  // ---------------------------------------------------------------- account views

  accountDTO(address: Address): AccountDTO {
    const { store, market } = this.deps;
    const balance = store.getBalance(address) ?? 0;
    let unrealized = 0;
    let usedMargin = 0;
    let leverage = 10;
    for (const p of store.listPositions(address)) {
      if (!isMarketSymbol(p.symbol) || p.size === 0) continue;
      const cfg = getMarket(p.symbol);
      leverage = cfg.maxLeverage;
      const mark = market.mid(p.symbol) ?? p.entryPrice;
      unrealized += p.size * (mark - p.entryPrice);
      usedMargin += (Math.abs(p.size) * mark) / cfg.maxLeverage;
    }
    for (const o of this.working.values()) {
      if (o.account !== address || o.reduceOnly) continue;
      usedMargin += ((o.size - o.filledSize) * o.price) / getMarket(o.symbol).maxLeverage;
    }
    const equity = balance + unrealized;
    return {
      address,
      balance: round(balance, 6),
      equity: round(equity, 6),
      unrealizedPnl: round(unrealized, 6),
      usedMargin: round(usedMargin, 6),
      available: round(Math.max(0, equity - usedMargin), 6),
      leverage,
    };
  }

  positionsDTO(address: Address): PositionDTO[] {
    return this.deps.store
      .listPositions(address)
      .filter((p) => isMarketSymbol(p.symbol))
      .map((p) => this.positionDTO(p.account, p.symbol as MarketSymbol));
  }

  initialAccountMessages(address: Address): ServerMessage[] {
    return [
      { type: 'account', account: this.accountDTO(address) },
      ...this.positionsDTO(address).map((position) => ({ type: 'position' as const, position })),
    ];
  }

  resetAccount(address: Address, balance: number): void {
    for (const [id, o] of this.working) if (o.account === address) this.working.delete(id);
    this.deps.store.resetAccount(address, balance);
  }

  // ---------------------------------------------------------------- internals

  /** Fill `order` against the current book; must run inside a transaction. */
  private execute(
    order: OrderDTO,
    liquidity: 'maker' | 'taker',
    fills: FillDTO[],
    outbox: Outbox,
  ): void {
    const { store, market } = this.deps;
    const symbol = order.symbol as MarketSymbol;
    const cfg = getMarket(symbol);
    const sizeDecimals = decimalsOf(cfg.stepSize);
    const wasPending = order.status === 'pending';
    let remaining = round(order.size - order.filledSize, sizeDecimals);

    if (order.reduceOnly) {
      // Never let a reduce-only order grow or flip the position.
      const pos = store.getPosition(order.account, symbol).size;
      const reducible =
        (order.side === 'buy' && pos < 0) || (order.side === 'sell' && pos > 0) ? Math.abs(pos) : 0;
      if (reducible < EPSILON) {
        this.transition(order, 'cancel', 'reduce_only_violation');
        this.working.delete(order.id);
        store.updateOrder(order);
        return;
      }
      remaining = Math.min(remaining, reducible);
    }

    const plans = planFills(market.book(symbol), order.side, order.price, remaining, sizeDecimals);
    for (const plan of plans) {
      // A resting order fills at its own limit price (it was the maker).
      const price = liquidity === 'maker' ? order.price : plan.price;
      fills.push(this.recordFill(order, price, plan.size, liquidity, outbox));
    }

    const done = order.size - order.filledSize < EPSILON;
    if (plans.length) this.transition(order, done ? 'fill' : 'partial_fill');

    if (order.type === 'market' && !done) {
      // IOC: whatever did not fill immediately is canceled.
      this.transition(order, 'cancel', plans.length ? 'ioc_remainder_canceled' : 'no_liquidity');
    } else if (order.status === 'pending') {
      this.transition(order, 'accept');
    }

    if (isWorking(order.status)) this.working.set(order.id, order);
    else this.working.delete(order.id);
    store.updateOrder(order);
    if (plans.length || wasPending) this.queueAccount(order.account, outbox);
  }

  private recordFill(
    order: OrderDTO,
    price: number,
    size: number,
    liquidity: 'maker' | 'taker',
    outbox: Outbox,
  ): FillDTO {
    const { store, metrics } = this.deps;
    const symbol = order.symbol as MarketSymbol;
    const sizeDecimals = decimalsOf(getMarket(symbol).stepSize);
    const fee = round(price * size * (liquidity === 'maker' ? MAKER_FEE_RATE : TAKER_FEE_RATE), 6);
    const pos = store.getPosition(order.account, symbol);
    const next = applyFill(pos, order.side, size, price, sizeDecimals);
    store.savePosition({
      account: order.account,
      symbol,
      size: next.size,
      entryPrice: next.entryPrice,
      realizedPnl: next.realizedPnl,
    });
    store.addBalance(order.account, next.realized - fee);

    const prevFilled = order.filledSize;
    order.filledSize = round(prevFilled + size, sizeDecimals);
    order.avgFillPrice = ((order.avgFillPrice ?? 0) * prevFilled + price * size) / order.filledSize;

    const fill: FillDTO = {
      id: randomUUID(),
      orderId: order.id,
      cloid: order.cloid,
      symbol,
      side: order.side,
      price,
      size,
      fee,
      liquidity,
      realizedPnl: next.realized,
      ts: this.now(),
    };
    store.insertFill({ ...fill, account: order.account });
    metrics.fills.inc({ liquidity });
    outbox.push(() => {
      this.deps.events.fill(order.account, fill);
      this.deps.events.position(order.account, this.positionDTO(order.account, symbol));
    });
    return fill;
  }

  private positionDTO(account: Address, symbol: MarketSymbol): PositionDTO {
    const p = this.deps.store.getPosition(account, symbol);
    const mark = this.deps.market.mid(symbol) ?? null;
    const ref = mark ?? p.entryPrice;
    return {
      symbol,
      size: p.size,
      entryPrice: round(p.entryPrice, 2),
      markPrice: mark,
      unrealizedPnl: round(p.size * (ref - p.entryPrice), 6),
      realizedPnl: p.realizedPnl,
      margin: round((Math.abs(p.size) * ref) / getMarket(symbol).maxLeverage, 6),
    };
  }

  private riskCheck(
    order: OrderDTO,
    priceBandPct: number,
    maxLeverage: number,
  ):
    | 'market_unavailable'
    | 'price_out_of_band'
    | 'reduce_only_violation'
    | 'insufficient_margin'
    | null {
    const symbol = order.symbol as MarketSymbol;
    const { market, store } = this.deps;
    const mid = market.mid(symbol);
    if (market.status(symbol) !== 'live' || mid === undefined) return 'market_unavailable';
    if ((Math.abs(order.price - mid) / mid) * 100 > priceBandPct) return 'price_out_of_band';
    if (order.reduceOnly) {
      const pos = store.getPosition(order.account, symbol).size;
      const reduces = (order.side === 'buy' && pos < 0) || (order.side === 'sell' && pos > 0);
      return reduces && order.size <= Math.abs(pos) + EPSILON ? null : 'reduce_only_violation';
    }
    const refPrice = order.type === 'limit' ? order.price : mid;
    const required = (order.size * refPrice) / maxLeverage;
    return required > this.accountDTO(order.account).available + EPSILON
      ? 'insufficient_margin'
      : null;
  }

  private transition(order: OrderDTO, event: OrderEvent, reason?: string): void {
    order.status = nextStatus(order.status, event);
    if (reason) order.reason = reason;
    order.updatedAt = this.now();
  }

  private queueAccount(account: Address, outbox: Outbox): void {
    outbox.push(() => this.deps.events.account(this.accountDTO(account)));
  }

  private flush(outbox: Outbox): void {
    for (const fn of outbox) {
      try {
        fn();
      } catch (err) {
        this.deps.log.error({ err }, 'event publish failed');
      }
    }
  }

  private assertSessionAccount(session: SessionRow, account: Address, chainId?: number): void {
    if (account !== session.address) throw new AppError('account_mismatch');
    if (chainId !== undefined && chainId !== this.deps.chainId) throw new AppError('wrong_chain');
    if (session.chainId !== this.deps.chainId) throw new AppError('wrong_chain');
  }

  private assertDeadline(deadline: bigint): void {
    const nowSec = Math.floor(this.now() / 1000);
    const d = Number(deadline);
    if (d <= nowSec - CLOCK_SKEW_SEC) throw new AppError('expired');
    if (d > nowSec + MAX_ORDER_TTL_SEC + CLOCK_SKEW_SEC) throw new AppError('deadline_too_far');
  }

  private assertAuthorized(account: Address, signer: Address): void {
    if (signer === account) return;
    const validUntil = this.deps.store.getAgentValidUntil(account, signer);
    if (validUntil && validUntil > this.now()) return;
    throw new AppError('signer_not_authorized');
  }
}

async function recoverSigner(typed: TypedDataDefinition, signature: Hex): Promise<Address> {
  try {
    return await recoverTypedDataAddress({ ...typed, signature } as Parameters<
      typeof recoverTypedDataAddress
    >[0]);
  } catch {
    throw new AppError('invalid_signature');
  }
}

/** Exact tick/step validation on the signed integers. */
export function validateOrderParams(msg: OrderMessage): string | null {
  const cfg = getMarket(msg.symbol);
  if (msg.priceE8 <= 0n) return 'price must be positive';
  if (msg.priceE8 % toE8(cfg.tickSize) !== 0n) return `price must be a multiple of ${cfg.tickSize}`;
  if (msg.sizeE8 < toE8(cfg.minSize)) return `size must be at least ${cfg.minSize}`;
  if (msg.sizeE8 % toE8(cfg.stepSize) !== 0n) return `size must be a multiple of ${cfg.stepSize}`;
  return null;
}
