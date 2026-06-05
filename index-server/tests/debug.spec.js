import { test, expect } from '@playwright/test';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'olw_admin_bab913168dc5fcc4e143660fc8c249b1b1e3c6cae1818564a9aef3f63a30baa0';

test('debug admin login', async ({ page }) => {
  const logs = [];
  const errors = [];
  const requests = [];

  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => errors.push(err.message));
  page.on('request', req => {
    if (req.url().includes('admin')) requests.push(`${req.method()} ${req.url()}`);
  });
  page.on('response', res => {
    if (res.url().includes('admin')) requests.push(`→ ${res.status()} ${res.url()}`);
  });

  await page.goto('/admin');

  // Check button exists and is enabled
  const btn = page.locator('#login-btn');
  console.log('button visible:', await btn.isVisible());
  console.log('button enabled:', await btn.isEnabled());

  await page.fill('#secret-input', ADMIN_SECRET);
  await page.click('#login-btn');
  await page.waitForTimeout(4000);

  console.log('=== Console logs ===');
  logs.forEach(l => console.log(l));
  console.log('=== JS Errors ===');
  errors.forEach(e => console.log(e));
  console.log('=== Network ===');
  requests.forEach(r => console.log(r));
  console.log('=== DOM state ===');
  console.log('login-screen visible:', await page.locator('#login-screen').isVisible());
  console.log('dashboard visible:', await page.locator('#dashboard').isVisible());
  console.log('login-error text:', await page.locator('#login-error').textContent());

  // Just pass — this is a diagnostic test
  expect(true).toBe(true);
});
