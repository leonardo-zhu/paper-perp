import {
  type AccountDTO,
  cancelTypedData,
  decimalsOf,
  type FillDTO,
  getMarket,
  type MarketSymbol,
  type OrderDTO,
  type OrderMessage,
  orderTypedData,
  type PlaceOrderResponse,
  type PositionDTO,
  priceDecimals,
  toE8,
  toWire,
} from '@paperperp/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { type Hex, toHex } from 'viem';
import { useConnection } from 'wagmi';
import { CHAIN_ID } from '../config';
import { ApiError, api, describeError } from '../lib/api';
import { marketFeed, markOf, useMarket } from '../stores/market';
import { toast } from '../stores/toasts';
import { useSession } from './session';
import { deadlineIn, nextNonce, useSigner } from './signer';

export const keys = {
  account: ['account'] as const,
  orders: ['orders'] as const,
  fills: ['fills'] as const,
};

interface AccountResponse {
  account: AccountDTO;
  positions: PositionDTO[];
}

export function useAccountData() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: keys.account,
    queryFn: () => api<AccountResponse>('/api/account'),
    enabled: !!session,
  });
}

export function useOrders() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: keys.orders,
    queryFn: async () => (await api<{ orders: OrderDTO[] }>('/api/orders')).orders,
    enabled: !!session,
  });
}

export function useFills() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: keys.fills,
    queryFn: async () => (await api<{ fills: FillDTO[] }>('/api/fills')).fills,
    enabled: !!session,
  });
}

/** Merge an order into the cache, replacing an optimistic copy with the same cloid. */
function upsertOrder(qc: QueryClient, order: OrderDTO) {
  qc.setQueryData<OrderDTO[]>(keys.orders, (prev = []) => {
    const rest = prev.filter((o) => o.id !== order.id && o.cloid !== order.cloid);
    const existing = prev.find((o) => o.id === order.id);
    // Never let an older update overwrite a newer one (WS and HTTP can race).
    if (existing && existing.updatedAt > order.updatedAt) return prev;
    return [order, ...rest].sort((a, b) => b.createdAt - a.createdAt);
  });
}

/**
 * Keeps TanStack Query caches in sync with private WebSocket pushes, and
 * tells the feed when to (re)authenticate the socket.
 */
export function useAccountSync() {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const authenticated = useMarket((s) => s.authenticated);

  useEffect(() => {
    marketFeed.setSignedIn(!!session);
  }, [session]);

  // After every (re)connect, refetch once to cover events missed while offline.
  useEffect(() => {
    if (authenticated) void qc.invalidateQueries({ queryKey: keys.orders });
    if (authenticated) void qc.invalidateQueries({ queryKey: keys.fills });
    if (authenticated) void qc.invalidateQueries({ queryKey: keys.account });
  }, [authenticated, qc]);

  useEffect(
    () =>
      marketFeed.onPrivate((msg) => {
        if (msg.type === 'order') upsertOrder(qc, msg.order);
        if (msg.type === 'fill') {
          qc.setQueryData<FillDTO[]>(keys.fills, (prev = []) =>
            prev.some((f) => f.id === msg.fill.id) ? prev : [msg.fill, ...prev].slice(0, 100),
          );
        }
        if (msg.type === 'account') {
          qc.setQueryData<AccountResponse>(keys.account, (prev) =>
            prev ? { ...prev, account: msg.account } : prev,
          );
        }
        if (msg.type === 'position') {
          qc.setQueryData<AccountResponse>(keys.account, (prev) => {
            if (!prev) return prev;
            const others = prev.positions.filter((p) => p.symbol !== msg.position.symbol);
            return { ...prev, positions: [...others, msg.position] };
          });
        }
      }),
    [qc],
  );
}

export interface OrderInput {
  /** Defaults to the market on screen; set it when acting on another market (closing a position). */
  symbol?: MarketSymbol;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  /** Limit price (ignored for market orders). */
  price: string;
  size: string;
  reduceOnly: boolean;
  /** Max slippage for market orders, in percent. */
  slippagePct: number;
}

/** Market orders are IOC limits at a worst acceptable price derived from mid ± slippage. */
export function worstPrice(
  side: 'buy' | 'sell',
  mid: number,
  slippagePct: number,
  tickSize: string,
): string {
  const tick = Number(tickSize);
  const raw = side === 'buy' ? mid * (1 + slippagePct / 100) : mid * (1 - slippagePct / 100);
  const rounded = side === 'buy' ? Math.ceil(raw / tick) * tick : Math.floor(raw / tick) * tick;
  return rounded.toFixed(decimalsOf(tickSize));
}

function randomCloid(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export function usePlaceOrder() {
  const qc = useQueryClient();
  const { address } = useConnection();
  const { sign, forgetAgent } = useSigner(address);

  return useMutation({
    mutationFn: async (input: OrderInput): Promise<PlaceOrderResponse> => {
      if (!address) throw new Error('Connect your wallet first.');
      const symbol = input.symbol ?? marketFeed.symbol;
      const market = getMarket(symbol);
      const mid = markOf(useMarket.getState(), symbol);
      if (input.type === 'market' && !mid) throw new Error(`No ${symbol} price yet.`);
      const price =
        input.type === 'market'
          ? worstPrice(input.side, mid!, input.slippagePct, market.tickSize)
          : input.price;
      const message: OrderMessage = {
        account: address,
        symbol,
        isBuy: input.side === 'buy',
        orderType: input.type === 'market' ? 1 : 0,
        priceE8: toE8(price),
        sizeE8: toE8(input.size),
        reduceOnly: input.reduceOnly,
        cloid: randomCloid(),
        nonce: nextNonce(),
        deadline: deadlineIn(60),
      };

      // Optimistic row so the order shows up instantly; reconciled by cloid.
      const now = Date.now();
      upsertOrder(qc, {
        id: `local-${message.cloid}`,
        cloid: message.cloid,
        account: address,
        signer: address,
        symbol,
        side: input.side,
        type: input.type,
        price: Number(price),
        size: Number(input.size),
        filledSize: 0,
        avgFillPrice: null,
        reduceOnly: input.reduceOnly,
        status: 'pending',
        reason: null,
        createdAt: now,
        updatedAt: 0,
      });

      try {
        const signature = await sign(orderTypedData(CHAIN_ID, message));
        return await api<PlaceOrderResponse>('/api/orders', {
          body: { order: toWire(message), signature, chainId: CHAIN_ID },
        });
      } catch (err) {
        const rejected =
          err instanceof ApiError ? (err.body?.order as OrderDTO | undefined) : undefined;
        if (rejected) upsertOrder(qc, rejected);
        else
          qc.setQueryData<OrderDTO[]>(keys.orders, (prev = []) =>
            prev.filter((o) => o.cloid !== message.cloid),
          );
        if (err instanceof ApiError && err.code === 'signer_not_authorized') forgetAgent();
        throw err;
      }
    },
    onSuccess: (res) => {
      upsertOrder(qc, res.order);
      const o = res.order;
      const base = getMarket(o.symbol).base;
      if (o.status === 'filled')
        toast.success(
          `${o.side === 'buy' ? 'Bought' : 'Sold'} ${o.filledSize} ${base} @ ${o.avgFillPrice?.toFixed(priceDecimals(o.symbol))}`,
        );
      else if (o.status === 'open') toast.info(`${o.symbol}: Limit order placed @ ${o.price}`);
      else if (o.status === 'partially_filled')
        toast.info(`Partially filled ${o.filledSize}/${o.size} ${base}`);
      else if (o.status === 'canceled')
        toast.error(
          o.reason === 'no_liquidity'
            ? 'No liquidity within your slippage.'
            : `Order canceled: ${o.reason}`,
        );
    },
    onError: (err) => {
      toast.error(describeError(err));
    },
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  const { address } = useConnection();
  const { sign } = useSigner(address);
  return useMutation({
    mutationFn: async (order: OrderDTO) => {
      if (!address) throw new Error('Connect your wallet first.');
      const cancel = {
        account: address,
        cloid: order.cloid as Hex,
        nonce: nextNonce(),
        deadline: deadlineIn(60),
      };
      const signature = await sign(cancelTypedData(CHAIN_ID, cancel));
      return (
        await api<{ order: OrderDTO }>('/api/orders/cancel', {
          body: { cancel: toWire(cancel), signature, chainId: CHAIN_ID },
        })
      ).order;
    },
    onSuccess: (order) => upsertOrder(qc, order),
    onError: (err) => toast.error(describeError(err)),
  });
}

export function useResetAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AccountResponse>('/api/account/reset', { method: 'POST', body: {} }),
    onSuccess: (data) => {
      qc.setQueryData(keys.account, data);
      qc.setQueryData(keys.orders, []);
      qc.setQueryData(keys.fills, []);
      toast.success('Account reset to 10,000 USDC.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
}

/** Live unrealised PnL from a local mark (mirror or tickers), so it ticks without server pushes. */
export function liveUnrealized(position: PositionDTO, mark: number | undefined): number {
  const ref = mark ?? position.markPrice ?? position.entryPrice;
  return position.size * (ref - position.entryPrice);
}
