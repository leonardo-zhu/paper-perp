/** Error codes returned by the gateway. The UI maps each to a readable message. */
export const ERROR_MESSAGES = {
  unauthorized: 'Sign in with your wallet first.',
  session_expired: 'Your session expired. Sign in again.',
  invalid_request: 'The request was malformed.',
  invalid_signature: 'The signature could not be verified.',
  account_mismatch: 'The order account does not match the signed-in wallet.',
  signer_not_authorized: 'This key is not authorised to trade for the account.',
  wrong_chain: 'The signature was made for a different network.',
  nonce_reused: 'This nonce was already used by a different request.',
  expired: 'The signed request has expired.',
  deadline_too_far: 'The deadline is too far in the future.',
  market_unavailable: 'Market data is stale, trading is paused.',
  unknown_market: 'Unknown market.',
  invalid_order: 'The order parameters are invalid.',
  price_out_of_band: 'Price is too far from the current market.',
  insufficient_margin: 'Not enough available margin.',
  reduce_only_violation: 'Reduce-only order would increase the position.',
  no_liquidity: 'No liquidity at or better than your price.',
  order_not_found: 'Order not found.',
  order_not_open: 'The order is no longer open.',
  rate_limited: 'Too many requests, slow down.',
  internal: 'Something went wrong on our side.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; requestId?: string };
}

export function errorMessage(code: string): string {
  return (ERROR_MESSAGES as Record<string, string>)[code] ?? ERROR_MESSAGES.internal;
}
