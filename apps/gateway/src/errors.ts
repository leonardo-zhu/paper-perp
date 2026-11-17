import { ERROR_MESSAGES, type ErrorCode } from '@paperperp/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const STATUS: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  unauthorized: 401,
  session_expired: 401,
  invalid_request: 400,
  invalid_signature: 401,
  account_mismatch: 403,
  signer_not_authorized: 403,
  wrong_chain: 400,
  nonce_reused: 409,
  expired: 400,
  deadline_too_far: 400,
  market_unavailable: 503,
  unknown_market: 404,
  invalid_order: 400,
  order_not_found: 404,
  order_not_open: 409,
  rate_limited: 429,
  internal: 500,
};

/** Expected, user-facing failure. Anything else is a bug and goes to Sentry. */
export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    status?: ContentfulStatusCode,
    /** Extra payload returned alongside the error (e.g. the rejected order). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_MESSAGES[code]);
    this.status = status ?? STATUS[code] ?? 422;
  }
}
