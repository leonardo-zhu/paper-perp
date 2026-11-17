import * as Sentry from '@sentry/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { App } from './App';
import { RELEASE, SENTRY_DSN } from './config';
import { ApiError } from './lib/api';
import { wagmiConfig } from './lib/wagmi';
import './styles.css';

if (SENTRY_DSN) {
  Sentry.init({ dsn: SENTRY_DSN, release: RELEASE, tracesSampleRate: 0.1 });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't hammer the API on 4xx; do retry transient failures.
      retry: (count, err) =>
        !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      staleTime: 5_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p className="crash">Something broke. Reload the page.</p>}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
