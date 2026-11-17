import { useEffect } from 'react';
import { AccountPanel } from './components/AccountPanel';
import { Header } from './components/Header';
import { OrderBookPanel } from './components/OrderBookPanel';
import { OrderForm } from './components/OrderForm';
import { PriceChart } from './components/PriceChart';
import { StatusBanner, Toasts } from './components/StatusBanner';
import { TradesPanel } from './components/TradesPanel';
import { useAuthSync } from './features/session';
import { useAccountSync } from './features/trading';
import { marketFeed } from './stores/market';

export function App() {
  useEffect(() => {
    marketFeed.start();
    return () => marketFeed.stop();
  }, []);
  useAuthSync();
  useAccountSync();

  return (
    <div className="app">
      <Header />
      <StatusBanner />
      <main className="layout">
        <PriceChart />
        <OrderBookPanel />
        <OrderForm />
        <AccountPanel />
        <TradesPanel />
      </main>
      <footer className="foot muted small">
        Paper trading demo · real market data, simulated fills · no real funds · Charts by{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView
        </a>{' '}
        ·{' '}
        <a href="https://github.com/leonardo-zhu/paper-perp" target="_blank" rel="noreferrer">
          source
        </a>
      </footer>
      <Toasts />
    </div>
  );
}
