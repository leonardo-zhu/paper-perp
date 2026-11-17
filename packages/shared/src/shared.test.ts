import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { fromE8, isMultipleOf, toE8 } from './decimal';
import { type OrderMessage, orderTypedData, orderWireSchema, toWire } from './eip712';
import { InvalidTransitionError, nextStatus } from './order-state';
import { diffViews, OrderBook, viewsEqual } from './orderbook';

describe('decimal', () => {
  it('scales decimal strings without float error', () => {
    expect(toE8('0.1')).toBe(10_000_000n);
    expect(toE8('65000.5')).toBe(6_500_050_000_000n);
    expect(fromE8(toE8('0.00000001'))).toBe('0.00000001');
    expect(fromE8(toE8('12'))).toBe('12');
  });
  it('rejects malformed input', () => {
    expect(() => toE8('1e5')).toThrow();
    expect(() => toE8('-1')).toThrow();
    expect(() => toE8('0.123456789')).toThrow();
  });
  it('checks step multiples exactly', () => {
    expect(isMultipleOf('0.003', '0.001')).toBe(true);
    expect(isMultipleOf('0.0035', '0.001')).toBe(false);
    expect(isMultipleOf('65000.3', '0.1')).toBe(true);
  });
});

describe('OrderBook sequencing', () => {
  it('applies consecutive deltas and removes zero-size levels', () => {
    const book = new OrderBook();
    book.applySnapshot(10, [[100, 1]], [[101, 2]]);
    expect(
      book.applyDelta(
        10,
        11,
        [
          [100, 0],
          [99, 3],
        ],
        [],
      ),
    ).toBe('applied');
    expect(book.top(5)).toEqual({ bids: [[99, 3]], asks: [[101, 2]] });
  });
  it('detects gaps and duplicates', () => {
    const book = new OrderBook();
    expect(book.applyDelta(0, 1, [], [])).toBe('uninitialized');
    book.applySnapshot(5, [], []);
    expect(book.applyDelta(4, 5, [], [])).toBe('duplicate');
    expect(book.applyDelta(6, 7, [], [])).toBe('gap');
    expect(book.seq).toBe(5);
  });
  it('diffViews reproduces the next view when applied', () => {
    const prev = {
      bids: [
        [100, 1],
        [99, 1],
      ] as [number, number][],
      asks: [[101, 1]] as [number, number][],
    };
    const next = {
      bids: [
        [100, 2],
        [98, 1],
      ] as [number, number][],
      asks: [
        [101, 1],
        [102, 4],
      ] as [number, number][],
    };
    const book = new OrderBook();
    book.applySnapshot(1, prev.bids, prev.asks);
    const d = diffViews(prev, next);
    book.applyDelta(1, 2, d.bids, d.asks);
    expect(viewsEqual(book.top(10), next)).toBe(true);
  });
});

describe('order state machine', () => {
  it('follows the happy path', () => {
    let s = nextStatus('pending', 'accept');
    s = nextStatus(s, 'partial_fill');
    s = nextStatus(s, 'fill');
    expect(s).toBe('filled');
  });
  it('rejects transitions out of terminal states', () => {
    expect(() => nextStatus('filled', 'cancel')).toThrow(InvalidTransitionError);
    expect(() => nextStatus('canceled', 'fill')).toThrow(InvalidTransitionError);
  });
});

describe('EIP-712 order', () => {
  it('round-trips through the wire format and recovers the signer', async () => {
    const account = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    );
    const message: OrderMessage = {
      account: account.address,
      symbol: 'BTC-PERP',
      isBuy: true,
      orderType: 0,
      priceE8: toE8('65000.1'),
      sizeE8: toE8('0.01'),
      reduceOnly: false,
      cloid: '0x0123456789abcdef0123456789abcdef',
      nonce: 1n,
      deadline: 2_000_000_000n,
    };
    const signature = await account.signTypedData(orderTypedData(421614, message));
    const parsed = orderWireSchema.parse(JSON.parse(JSON.stringify(toWire(message))));
    const recovered = await recoverTypedDataAddress({
      ...orderTypedData(421614, parsed as OrderMessage),
      signature,
    });
    expect(recovered).toBe(account.address);
    const otherChain = await recoverTypedDataAddress({
      ...orderTypedData(1, parsed as OrderMessage),
      signature,
    });
    expect(otherChain).not.toBe(account.address);
  });
});

describe('OrderBook top-N and pruning', () => {
  const rand = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };

  it('top() matches a full sort on random books', () => {
    const r = rand(7);
    for (let round = 0; round < 50; round++) {
      const book = new OrderBook();
      const bids: [number, number][] = [];
      const asks: [number, number][] = [];
      const n = Math.floor(r() * 300);
      for (let i = 0; i < n; i++) {
        bids.push([Math.round(r() * 100_000) / 10, 1 + i]);
        asks.push([10_000 + Math.round(r() * 100_000) / 10, 1 + i]);
      }
      book.applySnapshot(0, bids, asks);
      const depth = 1 + Math.floor(r() * 30);
      const expectBids = [...book.bids].sort((a, b) => b[0] - a[0]).slice(0, depth);
      const expectAsks = [...book.asks].sort((a, b) => a[0] - b[0]).slice(0, depth);
      expect(book.top(depth)).toEqual({ bids: expectBids, asks: expectAsks });
    }
  });

  it('prune keeps only the best levels per side', () => {
    const book = new OrderBook();
    const bids = Array.from({ length: 50 }, (_, i) => [100 - i, 1] as [number, number]);
    const asks = Array.from({ length: 50 }, (_, i) => [101 + i, 1] as [number, number]);
    book.applySnapshot(0, bids, asks);
    const before = book.top(10);
    expect(book.prune(20)).toBe(60);
    expect(book.size).toBe(40);
    expect(book.top(10)).toEqual(before);
    expect(book.bestBid()).toBe(100);
    expect(Math.min(...book.bids.keys())).toBe(81);
  });
});
