import { describe, expect, it } from 'vitest';
import {
  createHarness,
  deadline,
  makeOrder,
  newAccount,
  nextNonce,
  signedApproval,
  signedCancel,
  signedOrder,
} from './harness';

describe('SIWE sign-in', () => {
  it('creates a session and rejects replay of the same message', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const message = await h.siweMessage(wallet);
    const signature = await wallet.signMessage({ message });
    const ok = await h.request('/api/auth/verify', { body: { message, signature } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i);

    const replay = await h.request('/api/auth/verify', { body: { message, signature } });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('expired');
  });

  it('rejects messages for another domain or chain', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const phishing = await h.siweMessage(wallet, { domain: 'evil.example' });
    const res1 = await h.request('/api/auth/verify', {
      body: { message: phishing, signature: await wallet.signMessage({ message: phishing }) },
    });
    expect(res1.body.error.code).toBe('invalid_request');

    const mainnet = await h.siweMessage(wallet, { chainId: 1 });
    const res2 = await h.request('/api/auth/verify', {
      body: { message: mainnet, signature: await wallet.signMessage({ message: mainnet }) },
    });
    expect(res2.body.error.code).toBe('wrong_chain');
  });

  it('rejects a signature from a different key', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const message = await h.siweMessage(wallet);
    const signature = await newAccount().signMessage({ message });
    const res = await h.request('/api/auth/verify', { body: { message, signature } });
    expect(res.body.error.code).toBe('invalid_signature');
  });

  it('protects trading routes', async () => {
    const h = createHarness();
    expect((await h.request('/api/account')).status).toBe(401);
  });
});

describe('order entry', () => {
  it('fills a market order by walking the book and charges taker fees', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const res = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { size: '1' })),
    });
    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe('filled');
    // 0.5 @ 65000.1 + 0.5 @ 65001
    expect(res.body.fills.map((f: { price: number }) => f.price)).toEqual([65_000.1, 65_001]);
    expect(res.body.order.avgFillPrice).toBeCloseTo(65_000.55, 6);

    const acct = await h.request('/api/account', { cookie });
    expect(acct.body.positions[0].size).toBe(1);
    expect(acct.body.account.balance).toBeLessThan(10_000);
  });

  it('is idempotent: the same signed order submitted twice fills once', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const body = await signedOrder(wallet, makeOrder(wallet));
    const [a, b] = await Promise.all([
      h.request('/api/orders', { cookie, body }),
      h.request('/api/orders', { cookie, body }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(a.body.order.id).toBe(b.body.order.id);
    const fills = await h.request('/api/fills', { cookie });
    expect(fills.body.fills).toHaveLength(1);
  });

  it('rejects a reused nonce with a different payload', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const nonce = nextNonce();
    await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { nonce })),
    });
    const res = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { nonce, size: '0.2' })),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('nonce_reused');
  });

  it('rejects expired and too-far deadlines', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const expired = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { deadline: deadline(-120) })),
    });
    expect(expired.body.error.code).toBe('expired');
    const far = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { deadline: deadline(3_600) })),
    });
    expect(far.body.error.code).toBe('deadline_too_far');
  });

  it('rejects signatures for another chain', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const body = await signedOrder(wallet, makeOrder(wallet), 1);
    const withHint = await h.request('/api/orders', { cookie, body: { ...body, chainId: 1 } });
    expect(withHint.body.error.code).toBe('wrong_chain');
    // Without the hint the signature recovers to some unrelated address.
    const noHint = await h.request('/api/orders', { cookie, body });
    expect(noHint.status).toBe(403);
    expect(noHint.body.error.code).toBe('signer_not_authorized');
  });

  it("rejects orders for someone else's account", async () => {
    const h = createHarness();
    const wallet = newAccount();
    const other = newAccount();
    const cookie = await h.login(wallet);
    const res = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(other, makeOrder(other)),
    });
    expect(res.body.error.code).toBe('account_mismatch');
  });

  it('validates tick and step size exactly', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const res = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { price: '65000.15' })),
    });
    expect(res.body.error.code).toBe('invalid_order');
  });

  it('pauses trading when market data is stale, recording the rejection', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    h.market.statusValue = 'stale';
    const res = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet)),
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('market_unavailable');
    expect(res.body.order.status).toBe('rejected');
  });

  it('applies the price band and margin checks', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const band = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { orderType: 0, price: '50000' })),
    });
    expect(band.body.error.code).toBe('price_out_of_band');
    // 10k collateral at 10x → ~1.5 BTC max notional at 65k.
    const margin = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { size: '2' })),
    });
    expect(margin.body.error.code).toBe('insufficient_margin');
  });

  it('cancels market remainder (IOC) when liquidity runs out', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const res = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(wallet, makeOrder(wallet, { size: '0.6', price: '65000.5' })),
    });
    expect(res.body.order.status).toBe('canceled');
    expect(res.body.order.reason).toBe('ioc_remainder_canceled');
    expect(res.body.order.filledSize).toBe(0.5);
  });
});

describe('resting limit orders', () => {
  it('rests, then fills as maker when the market crosses it', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const res = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(
        wallet,
        makeOrder(wallet, { orderType: 0, price: '64990', size: '0.3' }),
      ),
    });
    expect(res.body.order.status).toBe('open');

    h.market.setBook(
      [[64_980, 1]],
      [
        [64_989.5, 0.1],
        [64_990, 5],
      ],
    );
    h.engine.onBookChange('BTC-PERP');
    const orders = await h.request('/api/orders', { cookie });
    expect(orders.body.orders[0].status).toBe('filled');
    const fills = (await h.request('/api/fills', { cookie })).body.fills;
    expect(fills[0].liquidity).toBe('maker');
    expect(fills.every((f: { price: number }) => f.price === 64_990)).toBe(true);
  });

  it('cancels with a signed cancel and rejects cancelling twice', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const cookie = await h.login(wallet);
    const order = makeOrder(wallet, { orderType: 0, price: '64000', size: '0.1' });
    await h.request('/api/orders', { cookie, body: await signedOrder(wallet, order) });
    const cancel = {
      account: wallet.address,
      cloid: order.cloid,
      nonce: nextNonce(),
      deadline: deadline(),
    };
    const res = await h.request('/api/orders/cancel', {
      cookie,
      body: await signedCancel(wallet, cancel),
    });
    expect(res.body.order.status).toBe('canceled');
    const again = await h.request('/api/orders/cancel', {
      cookie,
      body: await signedCancel(wallet, { ...cancel, nonce: nextNonce() }),
    });
    expect(again.body.error.code).toBe('order_not_open');
  });
});

describe('agent wallets', () => {
  it('lets an approved agent trade, and rejects unapproved or revoked agents', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const agent = newAccount();
    const cookie = await h.login(wallet);

    const before = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(agent, makeOrder(wallet)),
    });
    expect(before.body.error.code).toBe('signer_not_authorized');

    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const approve = await h.request('/api/agents', {
      cookie,
      body: await signedApproval(wallet, {
        account: wallet.address,
        agent: agent.address,
        validUntil,
        nonce: nextNonce(),
      }),
    });
    expect(approve.status).toBe(200);

    const ok = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(agent, makeOrder(wallet)),
    });
    expect(ok.status).toBe(201);
    expect(ok.body.order.signer).toBe(agent.address);

    await h.request('/api/agents', {
      cookie,
      body: await signedApproval(wallet, {
        account: wallet.address,
        agent: agent.address,
        validUntil: 0n,
        nonce: nextNonce(),
      }),
    });
    const revoked = await h.request('/api/orders', {
      cookie,
      body: await signedOrder(agent, makeOrder(wallet)),
    });
    expect(revoked.body.error.code).toBe('signer_not_authorized');
  });

  it('does not let an agent approve other agents', async () => {
    const h = createHarness();
    const wallet = newAccount();
    const agent = newAccount();
    const cookie = await h.login(wallet);
    const res = await h.request('/api/agents', {
      cookie,
      body: await signedApproval(agent, {
        account: wallet.address,
        agent: newAccount().address,
        validUntil: BigInt(Math.floor(Date.now() / 1000) + 60),
        nonce: nextNonce(),
      }),
    });
    expect(res.body.error.code).toBe('signer_not_authorized');
  });
});
