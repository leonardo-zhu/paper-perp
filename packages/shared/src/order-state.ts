/**
 * Order lifecycle as an explicit state machine. Every status change in the
 * gateway goes through `nextStatus`, so an impossible transition (e.g. a
 * fill arriving for a canceled order) throws instead of corrupting state.
 *
 *   pending ──accept──▶ open ──fill──▶ partially_filled ──fill──▶ filled
 *      │                 │                   │
 *      ├─reject─▶ rejected                   │
 *      └──────────cancel / expire────────────┴──▶ canceled
 */
export const ORDER_STATUSES = [
  'pending',
  'open',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderEvent = 'accept' | 'reject' | 'partial_fill' | 'fill' | 'cancel';

const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderEvent, OrderStatus>>> = {
  pending: {
    accept: 'open',
    reject: 'rejected',
    partial_fill: 'partially_filled',
    fill: 'filled',
    cancel: 'canceled',
  },
  open: { partial_fill: 'partially_filled', fill: 'filled', cancel: 'canceled' },
  partially_filled: { partial_fill: 'partially_filled', fill: 'filled', cancel: 'canceled' },
  filled: {},
  canceled: {},
  rejected: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly event: OrderEvent,
  ) {
    super(`invalid order transition: ${from} --${event}-->`);
  }
}

export function nextStatus(from: OrderStatus, event: OrderEvent): OrderStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: OrderStatus, event: OrderEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function isTerminal(status: OrderStatus): boolean {
  return status === 'filled' || status === 'canceled' || status === 'rejected';
}

export function isWorking(status: OrderStatus): boolean {
  return status === 'open' || status === 'partially_filled';
}
