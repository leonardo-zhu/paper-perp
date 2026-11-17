import type { Address, Hex } from 'viem';
import { z } from 'zod';

/**
 * EIP-712 definitions shared by the browser (signing) and the gateway
 * (verification). One source of truth means a field rename breaks the
 * build instead of silently breaking signature recovery in production.
 */
export const EIP712_DOMAIN_NAME = 'PaperPerp';
export const EIP712_DOMAIN_VERSION = '1';

/** Orders/cancels must expire within this window (seconds). */
export const MAX_ORDER_TTL_SEC = 5 * 60;
/** Agent keys can be authorised for at most this long (seconds). */
export const MAX_AGENT_VALIDITY_SEC = 7 * 24 * 60 * 60;

export function eip712Domain(chainId: number) {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId } as const;
}

export const OrderType = { Limit: 0, Market: 1 } as const;
export type OrderTypeCode = (typeof OrderType)[keyof typeof OrderType];

export const ORDER_TYPES = {
  Order: [
    { name: 'account', type: 'address' },
    { name: 'symbol', type: 'string' },
    { name: 'isBuy', type: 'bool' },
    { name: 'orderType', type: 'uint8' },
    { name: 'priceE8', type: 'uint256' },
    { name: 'sizeE8', type: 'uint256' },
    { name: 'reduceOnly', type: 'bool' },
    { name: 'cloid', type: 'bytes16' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const CANCEL_TYPES = {
  Cancel: [
    { name: 'account', type: 'address' },
    { name: 'cloid', type: 'bytes16' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

/** validUntil = 0 revokes the agent. */
export const APPROVE_AGENT_TYPES = {
  ApproveAgent: [
    { name: 'account', type: 'address' },
    { name: 'agent', type: 'address' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export interface OrderMessage {
  account: Address;
  symbol: string;
  isBuy: boolean;
  orderType: OrderTypeCode;
  /** Limit price, or worst acceptable price for market (IOC) orders. */
  priceE8: bigint;
  sizeE8: bigint;
  reduceOnly: boolean;
  cloid: Hex;
  nonce: bigint;
  deadline: bigint;
}

export interface CancelMessage {
  account: Address;
  cloid: Hex;
  nonce: bigint;
  deadline: bigint;
}

export interface ApproveAgentMessage {
  account: Address;
  agent: Address;
  validUntil: bigint;
  nonce: bigint;
}

export function orderTypedData(chainId: number, message: OrderMessage) {
  return {
    domain: eip712Domain(chainId),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message,
  } as const;
}

export function cancelTypedData(chainId: number, message: CancelMessage) {
  return {
    domain: eip712Domain(chainId),
    types: CANCEL_TYPES,
    primaryType: 'Cancel',
    message,
  } as const;
}

export function approveAgentTypedData(chainId: number, message: ApproveAgentMessage) {
  return {
    domain: eip712Domain(chainId),
    types: APPROVE_AGENT_TYPES,
    primaryType: 'ApproveAgent',
    message,
  } as const;
}

// ---- JSON wire format (bigint → decimal string) ----

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as unknown as z.ZodType<Address>;
const hex = (bytes?: number) =>
  z
    .string()
    .regex(bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]*$/)
    .transform((v) => v.toLowerCase() as Hex);
const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v));

export const signatureSchema = hex();

export const orderWireSchema = z.object({
  account: address,
  symbol: z.string().min(1).max(32),
  isBuy: z.boolean(),
  orderType: z.union([z.literal(0), z.literal(1)]),
  priceE8: uint,
  sizeE8: uint,
  reduceOnly: z.boolean(),
  cloid: hex(16),
  nonce: uint,
  deadline: uint,
});

export const cancelWireSchema = z.object({
  account: address,
  cloid: hex(16),
  nonce: uint,
  deadline: uint,
});

export const approveAgentWireSchema = z.object({
  account: address,
  agent: address,
  validUntil: uint,
  nonce: uint,
});

type Wire<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };
export type OrderWire = Wire<OrderMessage>;
export type CancelWire = Wire<CancelMessage>;
export type ApproveAgentWire = Wire<ApproveAgentMessage>;

export function toWire<T extends object>(message: T): Wire<T> {
  return Object.fromEntries(
    Object.entries(message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
  ) as Wire<T>;
}
