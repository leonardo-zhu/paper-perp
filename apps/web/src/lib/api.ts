import { type ErrorCode, errorMessage } from '@paperperp/shared';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network' | 'wallet_rejected' | 'wallet',
    message: string,
    readonly status: number,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** JSON fetch with the session cookie and typed errors. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError('network', 'Network error, check your connection.', 0);
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = json.error as { code?: ErrorCode; message?: string } | undefined;
    const code = err?.code ?? 'internal';
    throw new ApiError(code, err?.message ?? errorMessage(code), res.status, json);
  }
  return json as T;
}

/** Turn wallet/viem/api errors into one short sentence for a toast. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const e = err as { name?: string; shortMessage?: string; message?: string; code?: number };
  if (e?.name === 'UserRejectedRequestError' || e?.code === 4001) {
    return 'You rejected the request in your wallet.';
  }
  if (e?.name === 'ConnectorNotConnectedError') return 'Connect your wallet first.';
  return e?.shortMessage ?? e?.message ?? 'Something went wrong.';
}

export function isUserRejection(err: unknown): boolean {
  const e = err as { name?: string; code?: number; cause?: { code?: number } };
  return e?.name === 'UserRejectedRequestError' || e?.code === 4001 || e?.cause?.code === 4001;
}
