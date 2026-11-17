import { randomBytes } from 'node:crypto';
import { STARTING_BALANCE_USDC } from '@paperperp/shared';
import { getAddress, type Hex, isAddress, recoverMessageAddress } from 'viem';
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import type { SessionRow, Store } from '../db/store';
import { AppError } from '../errors';

const NONCE_TTL_MS = 5 * 60_000;
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;

export interface AuthConfig {
  chainId: number;
  siweDomains: string[];
  allowedOrigins: string[];
  sessionTtlMs: number;
}

/**
 * Sign-In with Ethereum (EIP-4361). The server issues a single-use nonce,
 * the wallet signs a human-readable message containing it, and we verify
 * domain, origin, chain, freshness and signature before creating a session.
 */
export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly cfg: AuthConfig,
    private readonly now: () => number = Date.now,
  ) {}

  issueNonce(): string {
    const nonce = generateSiweNonce();
    this.store.createSiweNonce(nonce, this.now() + NONCE_TTL_MS);
    return nonce;
  }

  async verify(message: string, signature: Hex): Promise<SessionRow> {
    const now = this.now();
    const parsed = parseSiweMessage(message);
    if (
      !parsed.address ||
      !isAddress(parsed.address) ||
      !parsed.nonce ||
      !parsed.domain ||
      !parsed.uri
    ) {
      throw new AppError('invalid_request', 'malformed SIWE message');
    }
    if (parsed.version !== '1') throw new AppError('invalid_request', 'unsupported SIWE version');
    // Phishing guard: a message signed for another site must not log in here.
    if (!this.cfg.siweDomains.includes(parsed.domain)) {
      throw new AppError('invalid_request', `SIWE domain ${parsed.domain} is not accepted`);
    }
    if (!this.cfg.allowedOrigins.includes(safeOrigin(parsed.uri))) {
      throw new AppError('invalid_request', 'SIWE uri is not accepted');
    }
    if (parsed.chainId !== this.cfg.chainId) {
      throw new AppError('wrong_chain', `sign in on chain ${this.cfg.chainId}`);
    }
    const issuedAt = parsed.issuedAt?.getTime();
    if (!issuedAt || issuedAt < now - MAX_MESSAGE_AGE_MS || issuedAt > now + MAX_CLOCK_SKEW_MS) {
      throw new AppError('expired', 'SIWE message is too old or from the future');
    }
    if (!validateSiweMessage({ message: parsed, time: new Date(now) })) {
      throw new AppError('expired', 'SIWE message is expired or not yet valid');
    }

    const address = getAddress(parsed.address);
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message, signature });
    } catch {
      throw new AppError('invalid_signature');
    }
    if (recovered !== address) throw new AppError('invalid_signature');

    // Synchronous from here on: consume nonce + create session atomically.
    return this.store.tx(() => {
      if (!this.store.consumeSiweNonce(parsed.nonce!, now)) {
        throw new AppError('expired', 'sign-in nonce is unknown, used or expired');
      }
      const session: SessionRow = {
        id: randomBytes(32).toString('base64url'),
        address,
        chainId: parsed.chainId!,
        expiresAt: now + this.cfg.sessionTtlMs,
      };
      this.store.createSession(session, now);
      this.store.ensureAccount(address, STARTING_BALANCE_USDC, now);
      return session;
    });
  }

  session(id: string | undefined): SessionRow | undefined {
    return id ? this.store.getSession(id, this.now()) : undefined;
  }

  logout(id: string): void {
    this.store.deleteSession(id);
  }
}

function safeOrigin(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    return '';
  }
}
