import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import Stripe from 'stripe';
import crypto from 'crypto';

const PORT = process.env.PORT || 3778;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const DOMAIN = process.env.OLW_DOMAIN || 'https://olw.io';
const DB_PATH = '/opt/olw/index-server/agents.json';
const KEYS_PATH = '/opt/olw/index-server/api-keys.json';
const RATE_PATH = '/opt/olw/index-server/rate-limits.json';

mkdirSync(dirname(DB_PATH), { recursive: true });

const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' }) : null;

// ── DB helpers ────────────────────────────────────────────────────────────────
function loadDB() { return existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, 'utf8')) : { agents: {} }; }
function saveDB(db) { writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function loadKeys() { return existsSync(KEYS_PATH) ? JSON.parse(readFileSync(KEYS_PATH, 'utf8')) : { keys: {} }; }
function saveKeys(k) { writeFileSync(KEYS_PATH, JSON.stringify(k, null, 2)); }
function loadRate() { return existsSync(RATE_PATH) ? JSON.parse(readFileSync(RATE_PATH, 'utf8')) : { ips: {} }; }
function saveRate(r) { writeFileSync(RATE_PATH, JSON.stringify(r, null, 2)); }

// ── Rate limiting — 10 queries/day free ───────────────────────────────────────
function checkRateLimit(ip, apiKey) {
  if (apiKey) {
    const keys = loadKeys();
    if (keys.keys[apiKey] && keys.keys[apiKey].active) return { allowed: true, tier: 'paid' };
    return { allowed: false, tier: 'invalid_key', error: 'Invalid API key' };
  }
  const today = new Date().toISOString().slice(0, 10);
  const rate = loadRate();
  if (!rate.ips[ip]) rate.ips[ip] = {};
  if (!rate.ips[ip][today]) rate.ips[ip][today] = 0;
  rate.ips[ip][today]++;
  saveRate(rate);
  const count = rate.ips[ip][today];
  if (count > 10) return { allowed: false, tier: 'free', error: `Free tier: 10 queries/day. Used: ${count}. Upgrade at ${DOMAIN}/pricing` };
  return { allowed: true, tier: 'free', remaining: 10 - count };
}

// ── API key generation ────────────────────────────────────────────────────────
function generateApiKey() {
  return 'olw_live_' + crypto.randomBytes(24).toString('hex');
}

// ── Fingerprint matching ──────────────────────────────────────────────────────
function matchFingerprint(agentFP, query) {
  for (const [axis, value] of Object.entries(query)) {
    if (['api_key', 'limit', 'offset'].includes(axis)) continue;
    if (!(axis in agentFP)) continue;
    const agentVal = agentFP[axis];
    if (Array.isArray(agentVal)) {
      const vals = Array.isArray(value) ? value : [value];
      if (!vals.some(v => agentVal.includes(v))) return false;
    } else if (typeof agentVal === 'boolean') {
      if (agentVal !== (value === 'true' || value === true)) return false;
    } else {
      if (String(agentVal) !== String(value)) return false;
    }
  }
  return true;
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      try { resolve({ parsed: JSON.parse(raw.toString()), raw }); }
      catch { resolve({ parsed: {}, raw }); }
    });
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const apiKey = req.headers['authorization']?.replace('Bearer ', '') || url.searchParams.get('api_key');

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── POST /register ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/register') {
    const { parsed: body } = await parseBody(req);
    if (!body.address || !body.fingerprint) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'address and fingerprint required' })); return;
    }
    const db = loadDB();
    db.agents[body.address] = { ...body, registered_at: new Date().toISOString(), last_seen: new Date().toISOString() };
    saveDB(db);
    res.writeHead(200);
    res.end(JSON.stringify({ registered: true, address: body.address, resolve_url: `${DOMAIN}/resolve?address=${encodeURIComponent(body.address)}` }));
    return;
  }

  // ── GET /resolve ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/resolve') {
    const address = url.searchParams.get('address');
    const db = loadDB();
    const agent = db.agents[address];
    if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found', address })); return; }
    res.writeHead(200); res.end(JSON.stringify(agent)); return;
  }

  // ── GET /query — rate limited ──────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/query') {
    const rate = checkRateLimit(ip, apiKey);
    if (!rate.allowed) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: rate.error, upgrade: `${DOMAIN}/pricing`, checkout: `/checkout` }));
      return;
    }

    const query = Object.fromEntries(url.searchParams.entries());
    const db = loadDB();
    const matches = Object.values(db.agents).filter(a => matchFingerprint(a.fingerprint, query));
    res.writeHead(200);
    res.end(JSON.stringify({
      query, count: matches.length, agents: matches,
      tier: rate.tier,
      ...(rate.remaining !== undefined && { free_remaining: rate.remaining }),
    }));
    return;
  }

  // ── GET /agents ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/agents') {
    const db = loadDB();
    res.writeHead(200);
    res.end(JSON.stringify({ count: Object.keys(db.agents).length, agents: Object.values(db.agents) }));
    return;
  }

  // ── POST /checkout — Stripe payment gate ───────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/checkout') {
    if (!stripe) { res.writeHead(503); res.end(JSON.stringify({ error: 'Stripe not configured' })); return; }
    const { parsed: body } = await parseBody(req);
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'OLW Pro',
              description: 'Unlimited agent queries, 100 registrations/month, priority support',
            },
            unit_amount: 2900, // $29/mo
            recurring: { interval: 'month' },
          },
          quantity: 1,
        }],
        metadata: { email: body.email || '', source: 'olw-index' },
        success_url: `${DOMAIN}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${DOMAIN}/pricing`,
        ...(body.email && { customer_email: body.email }),
      });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, checkout_url: session.url, session_id: session.id }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /webhook — Stripe event handler ──────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const { parsed: body } = await parseBody(req);
    try {
      const event = body; // Validate sig in prod with stripe.webhooks.constructEvent
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_email || session.metadata?.email;
        const newKey = generateApiKey();
        const keys = loadKeys();
        keys.keys[newKey] = {
          active: true,
          email,
          tier: 'pro',
          created_at: new Date().toISOString(),
          stripe_session: session.id,
          stripe_customer: session.customer,
        };
        saveKeys(keys);
        console.log(`[OLW] New Pro key issued for ${email}: ${newKey.slice(0, 20)}...`);
      }
      if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const keys = loadKeys();
        Object.entries(keys.keys).forEach(([k, v]) => {
          if (v.stripe_customer === sub.customer) { keys.keys[k].active = false; }
        });
        saveKeys(keys);
        console.log(`[OLW] Subscription cancelled for customer ${sub.customer}`);
      }
      res.writeHead(200); res.end(JSON.stringify({ received: true }));
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /pricing ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/pricing') {
    res.writeHead(200);
    res.end(JSON.stringify({
      free: { queries_per_day: 10, registrations: 1, price: '$0' },
      pro: { queries_per_day: 'unlimited', registrations: 100, price: '$29/mo', checkout: '/checkout' },
      enterprise: { queries_per_day: 'unlimited', registrations: 'unlimited', private_index: true, sla: true, price: 'contact', email: 'martings1@charleston.edu' },
    }));
    return;
  }

  // ── GET /verify ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/verify') {
    const key = apiKey;
    if (!key) { res.writeHead(400); res.end(JSON.stringify({ error: 'api_key required' })); return; }
    const keys = loadKeys();
    const record = keys.keys[key];
    if (!record) { res.writeHead(404); res.end(JSON.stringify({ valid: false })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({ valid: record.active, tier: record.tier, email: record.email }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    routes: ['POST /register', 'GET /resolve', 'GET /query', 'GET /agents',
             'POST /checkout', 'POST /webhook', 'GET /pricing', 'GET /verify'],
  }));
});

server.listen(PORT, () => {
  console.log(`OLW Resolution Index :${PORT} — Stripe ${stripe ? 'live' : 'not configured'}`);
  console.log(`Free tier: 10 queries/day | Pro: $29/mo via /checkout`);
});
