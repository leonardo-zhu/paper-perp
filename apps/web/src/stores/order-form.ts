import { defaultOrderSize } from '@paperperp/shared';
import { create } from 'zustand';
import { useMarket } from './market';

interface OrderFormState {
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  price: string;
  size: string;
  reduceOnly: boolean;
  slippagePct: number;
  set(patch: Partial<Omit<OrderFormState, 'set' | 'resetFor'>>): void;
  /** Clear the price and pick a sensible size after switching markets. */
  resetFor(symbol: string): void;
}

/** Shared so clicking a price in the order book can fill the form. */
export const useOrderForm = create<OrderFormState>((set) => ({
  side: 'buy',
  type: 'limit',
  price: '',
  size: defaultOrderSize(useMarket.getState().symbol),
  reduceOnly: false,
  slippagePct: 1,
  set: (patch) => set(patch),
  resetFor: (symbol) => set({ price: '', size: defaultOrderSize(symbol), reduceOnly: false }),
}));
