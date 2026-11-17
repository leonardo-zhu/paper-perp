import type { Address } from 'viem';
import { z } from 'zod';
import {
  approveAgentWireSchema,
  cancelWireSchema,
  orderWireSchema,
  signatureSchema,
} from './eip712';
import type { OrderStatus } from './order-state';

export type Side = 'buy' | 'sell';

export interface OrderDTO {
  id: string;
  cloid: string;
  account: Address;
  signer: Address;
  symbol: string;
  side: Side;
  type: 'limit' | 'market';
  price: number;
  size: number;
  filledSize: number;
  avgFillPrice: number | null;
  reduceOnly: boolean;
  status: OrderStatus;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FillDTO {
  id: string;
  orderId: string;
  cloid: string;
  symbol: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  liquidity: 'maker' | 'taker';
  realizedPnl: number;
  ts: number;
}

export interface PositionDTO {
  symbol: string;
  /** Signed: positive long, negative short. */
  size: number;
  entryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  margin: number;
}

export interface AccountDTO {
  address: Address;
  balance: number;
  equity: number;
  unrealizedPnl: number;
  usedMargin: number;
  available: number;
  leverage: number;
}

export interface SessionDTO {
  address: Address;
  chainId: number;
  expiresAt: number;
}

export interface AgentDTO {
  agent: Address;
  validUntil: number;
}

export interface Candle {
  /** Open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface TradeDTO {
  id: string;
  price: number;
  size: number;
  side: Side;
  ts: number;
}

// ---- request bodies ----

export const siweVerifyBodySchema = z.object({
  message: z.string().min(1).max(4000),
  signature: signatureSchema,
});

export const placeOrderBodySchema = z.object({
  order: orderWireSchema,
  signature: signatureSchema,
});

export const cancelOrderBodySchema = z.object({
  cancel: cancelWireSchema,
  signature: signatureSchema,
});

export const approveAgentBodySchema = z.object({
  approval: approveAgentWireSchema,
  signature: signatureSchema,
});

export interface PlaceOrderResponse {
  order: OrderDTO;
  fills: FillDTO[];
  /** True when this exact signed order was already processed (idempotent replay). */
  duplicate: boolean;
}
