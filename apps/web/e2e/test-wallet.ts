import { test as base, type Page } from '@playwright/test';
import { type Hex, hexToString, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Anvil's well-known dev key #1: test-only, holds nothing. */
const TEST_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const APP_CHAIN = 421614;

/**
 * A fake browser wallet for E2E. The page gets an EIP-1193 provider that
 * announces itself via EIP-6963 (exactly like MetaMask/Rabby do); every
 * request is forwarded to Node, which signs with viem. This exercises the
 * real wagmi connector, SIWE and EIP-712 code paths with no extension.
 */
export async function installTestWallet(page: Page, opts: { chainId?: number } = {}) {
  const account = privateKeyToAccount(TEST_KEY);
  let chainId = opts.chainId ?? APP_CHAIN;
  // Like a real wallet: no accounts are exposed until the user approves a connection.
  let authorized = false;

  await page.exposeFunction('__testWallet', async (method: string, params: unknown[]) => {
    switch (method) {
      case 'eth_requestAccounts':
        authorized = true;
        return [account.address];
      case 'eth_accounts':
        return authorized ? [account.address] : [];
      case 'eth_chainId':
        return `0x${chainId.toString(16)}`;
      case 'wallet_switchEthereumChain': {
        chainId = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        return { __event: 'chainChanged', value: `0x${chainId.toString(16)}` };
      }
      case 'wallet_requestPermissions':
      case 'wallet_getPermissions':
        return [{ parentCapability: 'eth_accounts' }];
      case 'personal_sign': {
        const [data] = params as [string];
        const message = isHex(data) ? hexToString(data) : data;
        return account.signMessage({ message });
      }
      case 'eth_signTypedData_v4': {
        const typed = JSON.parse((params as [string, string])[1]);
        delete typed.types.EIP712Domain;
        // Real wallets refuse typed data for a chain other than the active one.
        if (typed.domain.chainId !== undefined && Number(typed.domain.chainId) !== chainId) {
          throw new Error('Provided chainId does not match the currently active chain');
        }
        return account.signTypedData(typed);
      }
      default:
        throw new Error(`test wallet: unsupported method ${method}`);
    }
  });

  await page.addInitScript(() => {
    type Listener = (...args: unknown[]) => void;
    const listeners = new Map<string, Set<Listener>>();
    const emit = (event: string, value: unknown) => {
      for (const fn of listeners.get(event) ?? []) fn(value);
    };
    const provider = {
      isTestWallet: true,
      async request({ method, params }: { method: string; params?: unknown[] }) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: exposed by Playwright
          const res = await (window as any).__testWallet(method, params ?? []);
          if (res && typeof res === 'object' && '__event' in res) {
            emit(res.__event, res.value);
            return null;
          }
          return res;
        } catch (err) {
          throw Object.assign(new Error((err as Error).message), { code: 4200 });
        }
      },
      on(event: string, fn: Listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      removeListener(event: string, fn: Listener) {
        listeners.get(event)?.delete(fn);
      },
    };
    const info = {
      uuid: '00000000-0000-4000-8000-000000000001',
      name: 'Test Wallet',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      rdns: 'dev.paperperp.testwallet',
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
      );
    // biome-ignore lint/suspicious/noExplicitAny: test hook
    (window as any).__testWalletEmit = emit;
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });

  return {
    address: account.address,
    /** Simulate the user switching networks inside the wallet. */
    async changeChain(id: number) {
      chainId = id;
      await page.evaluate(
        // biome-ignore lint/suspicious/noExplicitAny: test hook
        (hex) => (window as any).__testWalletEmit('chainChanged', hex),
        `0x${id.toString(16)}`,
      );
    },
  };
}

export const test = base;
export { expect } from '@playwright/test';
