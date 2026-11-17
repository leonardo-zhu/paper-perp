import { expect, installTestWallet, test } from './test-wallet';

test.describe('market data', () => {
  test('streams a live order book and price', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('market-status')).toHaveAttribute('data-status', 'live');
    await expect(page.getByTestId('mid-price')).not.toHaveText('—');
    await expect(page.getByTestId('bids').locator('.book-row')).toHaveCount(12);
  });

  test('degrades to read-only on an upstream outage and recovers without reload', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('market-status')).toHaveAttribute('data-status', 'live');
    const midBefore = await page.getByTestId('mid-price').textContent();

    await request.post('/api/dev/fault', { data: { kind: 'disconnect' } });
    await expect(page.getByTestId('status-banner')).toBeVisible();
    await expect(page.getByTestId('submit-order')).toBeDisabled();

    await expect(page.getByTestId('status-banner')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId('market-status')).toHaveAttribute('data-status', 'live');
    await expect(page.getByTestId('mid-price')).not.toHaveText(midBefore ?? '');
  });

  test('marks the feed stale when the venue goes silent', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('market-status')).toHaveAttribute('data-status', 'live');
    await request.post('/api/dev/fault', { data: { kind: 'freeze', ms: 6_000 } });
    await expect(page.getByTestId('market-status')).toHaveAttribute('data-status', 'stale', {
      timeout: 8_000,
    });
    await expect(page.getByTestId('status-banner')).toContainText('stale');
    await expect(page.getByTestId('market-status')).toHaveAttribute('data-status', 'live', {
      timeout: 10_000,
    });
  });
});

test.describe('trading flow', () => {
  test('connect → SIWE → market order → 1-click limit → cancel → close', async ({ page }) => {
    await installTestWallet(page);
    await page.goto('/');
    await expect(page.getByTestId('market-status')).toHaveAttribute('data-status', 'live');

    // Connect through the EIP-6963 picker.
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByRole('button', { name: /Test Wallet/ }).click();

    // Sign in with Ethereum.
    await page.getByRole('banner').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
    await expect(page.getByText('10,000.00').first()).toBeVisible();

    // Market buy signed by the wallet.
    await page.getByRole('button', { name: 'Market', exact: true }).click();
    await page.getByLabel('Size (BTC)').fill('0.010');
    await page.getByTestId('submit-order').click();
    await expect(page.getByText(/Bought 0.01 @/)).toBeVisible();
    await expect(page.getByTestId('position-row')).toHaveCount(1);
    await expect(page.getByTestId('position-row')).toContainText('0.010');

    // Enable 1-click trading, then place a resting limit far below the market.
    await page.getByRole('button', { name: 'Enable' }).click();
    await expect(page.getByText(/1-click trading enabled/)).toBeVisible();
    await page.getByRole('button', { name: 'Limit', exact: true }).click();
    const mid = Number((await page.getByTestId('mid-price').textContent())!.replaceAll(',', ''));
    await page.getByLabel('Price (USDC)').fill((Math.floor(mid * 0.98 * 10) / 10).toFixed(1));
    await page.getByTestId('submit-order').click();
    await expect(page.getByText(/Limit order placed/)).toBeVisible();

    await page.getByRole('button', { name: /Open orders \(1\)/ }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: /Open orders \(0\)/ })).toBeVisible();

    // Close the position with a reduce-only market order (signed by the agent).
    await page.getByRole('button', { name: /Positions/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByTestId('position-row')).toHaveCount(0);

    await page.getByRole('button', { name: 'Order history' }).click();
    await expect(page.getByTestId('order-row').filter({ hasText: 'filled' })).toHaveCount(2);
  });

  test('pauses trading when the wallet changes network, and switches back', async ({ page }) => {
    const wallet = await installTestWallet(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByRole('button', { name: /Test Wallet/ }).click();
    await page.getByRole('banner').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Signed in', { exact: true })).toBeVisible();

    await wallet.changeChain(1);
    await expect(page.getByText('Wrong network.')).toBeVisible();
    await expect(page.getByTestId('submit-order')).toBeDisabled();

    await page
      .getByRole('region', { name: 'Place order' })
      .getByRole('button', { name: /Switch to/ })
      .click();
    await expect(page.getByText('Wrong network.')).toBeHidden();
  });
});
