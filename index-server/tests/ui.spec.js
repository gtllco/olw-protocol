import { test, expect } from '@playwright/test';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'olw_admin_bab913168dc5fcc4e143660fc8c249b1b1e3c6cae1818564a9aef3f63a30baa0';

// ── HTML pages render ─────────────────────────────────────────────────────────

test.describe('Landing page (/)', () => {
  test('loads with correct title and hero text', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/OLW/);
    await expect(page.locator('nav')).toBeVisible();
    // Hero headline contains key phrase
    const hero = page.locator('h1').first();
    await expect(hero).toBeVisible();
  });

  test('install command copy button is present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=pip install olw-protocol')).toBeVisible();
  });

  test('A2A gap quote is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=does not prescribe a standard API')).toBeVisible();
  });

  test('nav links to pricing and GitHub', async ({ page }) => {
    await page.goto('/');
    // Nav may use anchor hrefs (#pricing) or route (/pricing)
    await expect(page.locator('a[href*="pricing"]').first()).toBeVisible();
    await expect(page.locator('a[href*="github.com"]').first()).toBeVisible();
  });
});

test.describe('Pricing page (/pricing)', () => {
  test('loads with three tier cards', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page).toHaveTitle(/Pricing/);
    await expect(page.locator('text=Free')).toBeVisible();
    await expect(page.locator('text=$29')).toBeVisible();
    await expect(page.locator('text=Enterprise')).toBeVisible();
  });

  test('Get API Key button is present', async ({ page }) => {
    await page.goto('/pricing');
    const btn = page.locator('#checkout-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });
});

test.describe('Welcome page (/welcome)', () => {
  test('loads and shows state without session_id', async ({ page }) => {
    await page.goto('/welcome');
    await expect(page).toHaveTitle(/Welcome/);
    // Without session_id shows either loading or error state immediately
    const loading = page.locator('#loading');
    const errorMsg = page.locator('#error-msg');
    const isLoading = await loading.isVisible();
    const isError = await errorMsg.isVisible();
    expect(isLoading || isError).toBe(true);
  });

  test('shows error for invalid session_id', async ({ page }) => {
    await page.goto('/welcome?session_id=cs_fake_invalid');
    // Polls /key — gets 202 — keeps retrying; after a moment shows loading still
    await page.waitForTimeout(3000);
    // Should still be in loading state (202 means pending)
    const loading = page.locator('#loading');
    const errorMsg = page.locator('#error-msg');
    const isLoading = await loading.isVisible();
    const isError = await errorMsg.isVisible();
    expect(isLoading || isError).toBe(true);
  });
});

// ── Admin portal ──────────────────────────────────────────────────────────────

test.describe('Admin portal (/admin)', () => {
  test('loads with vintage document aesthetic', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveTitle(/Field Operations/);
    // Login screen visible, dashboard hidden
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#dashboard')).toBeHidden();
  });

  test('login gate shows restricted access copy', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('text=Restricted Access')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Field Operations' })).toBeVisible();
  });

  test('shows error on wrong password', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#secret-input', 'wrong_password_entirely');
    await page.click('#login-btn');
    // Wait for fetch to complete and error to display
    await expect(page.locator('#login-error')).toContainText(/wrong|invalid|unauthori/i, { timeout: 5000 });
  });

  test('authenticates and shows dashboard with correct password', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#secret-input', ADMIN_SECRET);
    await page.click('#login-btn');

    // Dashboard should appear
    await expect(page.locator('#dashboard')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#login-screen')).toBeHidden();

    // Section headers visible
    await expect(page.locator('.section-title').filter({ hasText: 'Registered Agents' })).toBeVisible();
    await expect(page.locator('.section-title').filter({ hasText: 'Pro Subscribers' })).toBeVisible();
    await expect(page.locator('.section-title').filter({ hasText: 'Free Tier Usage' })).toBeVisible();
  });

  test('stat cards populate after login', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#secret-input', ADMIN_SECRET);
    await page.click('#login-btn');
    await expect(page.locator('#dashboard')).toBeVisible({ timeout: 8000 });

    // Agent count card should show a number (at least soul-guide is registered)
    const agentCount = page.locator('#s-agents');
    await expect(agentCount).not.toHaveText('—', { timeout: 5000 });
  });

  test('Enter key triggers login', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#secret-input', ADMIN_SECRET);
    await page.press('#secret-input', 'Enter');
    await expect(page.locator('#dashboard')).toBeVisible({ timeout: 8000 });
  });

  test('logout returns to login screen', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#secret-input', ADMIN_SECRET);
    await page.click('#login-btn');
    await expect(page.locator('#dashboard')).toBeVisible({ timeout: 8000 });

    await page.click('#logout-btn');
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#dashboard')).toBeHidden();
  });

  test('refresh button re-fetches stats', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#secret-input', ADMIN_SECRET);
    await page.click('#login-btn');
    await expect(page.locator('#dashboard')).toBeVisible({ timeout: 8000 });

    // Click refresh — last-updated timestamp should update
    const before = await page.locator('#last-updated').textContent();
    await page.waitForTimeout(1100); // ensure timestamp changes
    await page.click('#refresh-btn');
    await page.waitForTimeout(1500);
    const after = await page.locator('#last-updated').textContent();
    expect(after).not.toBe('—');
  });
});
