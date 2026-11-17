import { create } from 'zustand';

interface OrderFormState {
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  price: string;
  size: string;
  reduceOnly: boolean;
  slippagePct: number;
  set(patch: Partial<Omit<OrderFormState, 'set'>>): void;
}

/** Shared so clicking a price in the order book can fill the form. */
export const useOrderForm = create<OrderFormState>((set) => ({
  side: 'buy',
  type: 'limit',
  price: '',
  size: '0.010',
  reduceOnly: false,
  slippagePct: 1,
  set: (patch) => set(patch),
}));
