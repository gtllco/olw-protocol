import { test, expect } from '@playwright/test';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'olw_admin_bab913168dc5fcc4e143660fc8c249b1b1e3c6cae1818564a9aef3f63a30baa0';

// ── Public API ────────────────────────────────────────────────────────────────

test.describe('GET /agents', () => {
  test('returns agent list with count', async ({ request }) => {
    const res = await request.get('/agents');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('agents');
    expect(Array.isArray(body.agents)).toBe(true);
  });
});

test.describe('GET /resolve', () => {
  test('resolves a known agent address', async ({ request }) => {
    const res = await request.get('/resolve?address=soul-guide@gtll.olw');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.address).toBe('soul-guide@gtll.olw');
    expect(body).toHaveProperty('endpoint');
    expect(body).toHaveProperty('fingerprint');
  });

  test('returns 404 for unknown address', async ({ request }) => {
    const res = await request.get('/resolve?address=nobody@unknown.olw');
    expect(res.status()).toBe(404);
  });
});

test.describe('GET /query', () => {
  test('returns matching agents for soul_compatible=true', async ({ request }) => {
    const res = await request.get('/query?soul_compatible=true');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('agents');
    expect(body.tier).toBe('free');
    expect(body).toHaveProperty('free_remaining');
  });

  test('returns empty results for unmatched query', async ({ request }) => {
    const res = await request.get('/query?domain=nonexistent_domain_xyz');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
  });
});

test.describe('POST /register', () => {
  test('registers a new agent', async ({ request }) => {
    const res = await request.post('/register', {
      data: {
        address: 'test-agent@playwright.olw',
        name: 'Playwright Test Agent',
        description: 'Ephemeral test agent — safe to delete.',
        endpoint: 'https://example.com/olw/test',
        fingerprint: {
          domain: 'testing',
          task_types: ['test'],
          input_formats: ['json'],
          output_formats: ['json'],
          context_depth: 'shallow',
          latency_class: 'fast',
          trust_level: 'open',
          soul_compatible: false,
        },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(true);
    expect(body.address).toBe('test-agent@playwright.olw');
    expect(body.resolve_url).toContain('playwright.olw');
  });

  test('rejects registration missing required fields', async ({ request }) => {
    const res = await request.post('/register', {
      data: { name: 'Missing address and fingerprint' },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('GET /pricing.json', () => {
  test('returns tier definitions', async ({ request }) => {
    const res = await request.get('/pricing.json');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('free');
    expect(body).toHaveProperty('pro');
    expect(body).toHaveProperty('enterprise');
    expect(body.pro.price).toBe('$29/mo');
  });
});

test.describe('GET /verify', () => {
  test('returns 400 when no api_key provided', async ({ request }) => {
    const res = await request.get('/verify');
    expect(res.status()).toBe(400);
  });

  test('returns 404 for invalid api_key', async ({ request }) => {
    const res = await request.get('/verify?api_key=olw_live_fake_key_for_testing_only');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });
});

test.describe('GET /key', () => {
  test('returns 400 when no session_id', async ({ request }) => {
    const res = await request.get('/key');
    expect(res.status()).toBe(400);
  });

  test('returns 202 pending for unknown session', async ({ request }) => {
    const res = await request.get('/key?session_id=cs_test_fake_session_id');
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('pending');
  });
});

// ── Admin API ────────────────────────────────────────────────────────────────

test.describe('GET /admin/stats', () => {
  test('returns 401 without secret', async ({ request }) => {
    const res = await request.get('/admin/stats');
    expect(res.status()).toBe(401);
  });

  test('returns 401 with wrong secret', async ({ request }) => {
    const res = await request.get('/admin/stats', {
      headers: { 'x-admin-secret': 'wrong_secret' },
    });
    expect(res.status()).toBe(401);
  });

  test('returns full stats with correct secret', async ({ request }) => {
    const res = await request.get('/admin/stats', {
      headers: { 'x-admin-secret': ADMIN_SECRET },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('agents');
    expect(body).toHaveProperty('subscribers');
    expect(body).toHaveProperty('queries');
    expect(body).toHaveProperty('server');
    expect(typeof body.agents.total).toBe('number');
    expect(typeof body.server.uptime_seconds).toBe('number');
  });
});

// ── Checkout (Stripe) ─────────────────────────────────────────────────────────

test.describe('POST /checkout', () => {
  test('creates a real Stripe checkout session', async ({ request }) => {
    const res = await request.post('/checkout', {
      data: { email: 'playwright-test@olw.gtll.app' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com/);
    expect(body.session_id).toMatch(/^cs_live_/);
  });
});
