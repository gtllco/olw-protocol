#!/usr/bin/env node
// End-to-end payment + API key flow test.
// Exercises the REAL signature-verified webhook path:
//   1. POST /checkout         → create live Stripe Checkout Session
//   2. POST /webhook          → fire a properly-signed checkout.session.completed
//   3. GET  /key?session_id   → retrieve the issued Pro API key
//   4. GET  /verify           → confirm key is valid + tier=pro
//   5. GET  /query (Bearer)   → confirm key unlocks Pro (no free-tier cap)
import crypto from 'crypto';
import { readFileSync } from 'fs';

const BASE = 'http://localhost:3778';

// Pull the webhook secret from the running service's env file
const env = readFileSync('/etc/gtll/olw-secrets.env', 'utf8');
const WEBHOOK_SECRET = env.match(/STRIPE_WEBHOOK_SECRET=(\S+)/)[1];

let pass = 0, fail = 0;
const ok  = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); fail++; };

function signStripe(payloadStr) {
  const ts = Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payloadStr}`;
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
  return `t=${ts},v1=${sig}`;
}

const run = async () => {
  console.log('\n\x1b[1mOLW E2E Payment + API Key Flow\x1b[0m\n');
  const testEmail = `e2e-${crypto.randomBytes(4).toString('hex')}@olw-test.dev`;

  // ── 1. Create checkout session ──────────────────────────────────────────────
  console.log('§1 POST /checkout');
  const coRes = await fetch(`${BASE}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail }),
  });
  const co = await coRes.json();
  coRes.status === 200 ? ok('checkout returns 200') : bad(`checkout status ${coRes.status}`);
  /^https:\/\/checkout\.stripe\.com/.test(co.checkout_url) ? ok(`live Stripe URL: ${co.checkout_url.slice(0,45)}…`) : bad('no Stripe checkout URL');
  /^cs_live_/.test(co.session_id) ? ok(`session id ${co.session_id.slice(0,20)}…`) : bad('no cs_live_ session id');
  const sessionId = co.session_id;

  // ── 2. Fire signed webhook (simulates Stripe after successful payment) ───────
  console.log('\n§2 POST /webhook  (signed checkout.session.completed)');
  const event = {
    id: 'evt_e2e_' + crypto.randomBytes(6).toString('hex'),
    type: 'checkout.session.completed',
    data: { object: {
      id: sessionId, object: 'checkout.session',
      customer: 'cus_e2e_' + crypto.randomBytes(6).toString('hex'),
      customer_email: testEmail,
      metadata: { email: testEmail, source: 'olw-index' },
    }},
  };
  const payloadStr = JSON.stringify(event);

  // 2a. reject a tampered signature
  const badRes = await fetch(`${BASE}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: payloadStr,
  });
  badRes.status === 400 ? ok('rejects invalid signature (400)') : bad(`bad sig got ${badRes.status}, expected 400`);

  // 2b. accept the correctly signed event
  const whRes = await fetch(`${BASE}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signStripe(payloadStr) },
    body: payloadStr,
  });
  const wh = await whRes.json();
  whRes.status === 200 && wh.received ? ok('accepts valid signature → key issued') : bad(`webhook status ${whRes.status}`);

  // ── 3. Retrieve issued key ───────────────────────────────────────────────────
  console.log('\n§3 GET /key?session_id');
  const keyRes = await fetch(`${BASE}/key?session_id=${encodeURIComponent(sessionId)}`);
  const keyBody = await keyRes.json();
  keyRes.status === 200 ? ok('key retrieval returns 200') : bad(`key status ${keyRes.status}`);
  /^olw_live_[0-9a-f]{48}$/.test(keyBody.api_key || '') ? ok(`issued key ${keyBody.api_key.slice(0,24)}…`) : bad(`malformed key: ${keyBody.api_key}`);
  keyBody.tier === 'pro' ? ok('tier = pro') : bad(`tier = ${keyBody.tier}`);
  keyBody.email === testEmail ? ok('email matches purchaser') : bad(`email mismatch: ${keyBody.email}`);
  const apiKey = keyBody.api_key;

  // ── 4. Verify key ─────────────────────────────────────────────────────────────
  console.log('\n§4 GET /verify');
  const vRes = await fetch(`${BASE}/verify?api_key=${apiKey}`);
  const v = await vRes.json();
  vRes.status === 200 && v.valid === true ? ok('key verifies as valid') : bad(`verify: status ${vRes.status} valid=${v.valid}`);
  v.tier === 'pro' ? ok('verify reports tier=pro') : bad(`verify tier=${v.tier}`);

  // invalid key → 404
  const v404 = await fetch(`${BASE}/verify?api_key=olw_live_not_a_real_key`);
  v404.status === 404 ? ok('unknown key → 404') : bad(`unknown key got ${v404.status}`);

  // ── 5. Key unlocks Pro tier on /query ────────────────────────────────────────
  console.log('\n§5 GET /query  (Bearer key → Pro, no free cap)');
  const qRes = await fetch(`${BASE}/query?domain=finance`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const q = await qRes.json();
  qRes.status === 200 ? ok('authed query returns 200') : bad(`query status ${qRes.status}`);
  q.tier === 'pro' ? ok('query tier=pro') : bad(`query tier=${q.tier}`);
  q.free_remaining === undefined ? ok('no free-tier cap applied to Pro key') : bad('free_remaining present on Pro key');

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch(e => { console.error('\x1b[31mFATAL\x1b[0m', e); process.exit(1); });
