import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import Stripe from 'stripe';
import crypto from 'crypto';

const PORT = process.env.PORT || 3778;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const DOMAIN = process.env.OLW_DOMAIN || 'https://olw.gtll.app';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DB_PATH = '/opt/olw/index-server/agents.json';
const KEYS_PATH = '/opt/olw/index-server/api-keys.json';
const RATE_PATH = '/opt/olw/index-server/rate-limits.json';

mkdirSync(dirname(DB_PATH), { recursive: true });

const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' }) : null;

// ── DB helpers ────────────────────────────────────────────────────────────────
function loadDB() { return existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, 'utf8')) : { agents: {} }; }
function saveDB(db) { writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function loadKeys() { return existsSync(KEYS_PATH) ? JSON.parse(readFileSync(KEYS_PATH, 'utf8')) : { keys: {}, by_session: {} }; }
function saveKeys(k) { writeFileSync(KEYS_PATH, JSON.stringify(k, null, 2)); }
function loadRate() { return existsSync(RATE_PATH) ? JSON.parse(readFileSync(RATE_PATH, 'utf8')) : { ips: {} }; }
function saveRate(r) { writeFileSync(RATE_PATH, JSON.stringify(r, null, 2)); }

// ── Rate limiting ─────────────────────────────────────────────────────────────
function checkRateLimit(ip, apiKey) {
  if (apiKey) {
    const keys = loadKeys();
    if (keys.keys[apiKey] && keys.keys[apiKey].active) return { allowed: true, tier: 'pro' };
    return { allowed: false, tier: 'invalid_key', error: 'Invalid API key. Get one at ' + DOMAIN + '/pricing' };
  }
  // Loopback (tests / server-local) is trusted — free-tier cap targets remote IPs.
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'unknown') {
    return { allowed: true, tier: 'free', remaining: 10 };
  }
  const today = new Date().toISOString().slice(0, 10);
  const rate = loadRate();
  if (!rate.ips[ip]) rate.ips[ip] = {};
  if (!rate.ips[ip][today]) rate.ips[ip][today] = 0;
  rate.ips[ip][today]++;
  saveRate(rate);
  const count = rate.ips[ip][today];
  if (count > 10) return { allowed: false, tier: 'free', error: `Free tier: 10 queries/day. Upgrade at ${DOMAIN}/pricing` };
  return { allowed: true, tier: 'free', remaining: 10 - count };
}

// Per-IP abuse limits for write/expensive actions. Buckets stored separately
// from the free-query counter so they don't interfere.
//   register: 10/day   ·   checkout: 20/hour
function checkActionLimit(ip, action) {
  // Loopback (tests / server-local) is trusted — limits target remote abuse.
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'unknown') return { allowed: true };
  const limits = { register: { max: 10, windowMs: 86400000 }, checkout: { max: 20, windowMs: 3600000 } };
  const cfg = limits[action];
  if (!cfg) return { allowed: true };
  const now = Date.now();
  const rate = loadRate();
  if (!rate.actions) rate.actions = {};
  if (!rate.actions[action]) rate.actions[action] = {};
  const arr = (rate.actions[action][ip] || []).filter(ts => now - ts < cfg.windowMs);
  if (arr.length >= cfg.max) {
    saveRate(rate);
    const retryMins = Math.ceil((cfg.windowMs - (now - arr[0])) / 60000);
    return { allowed: false, error: `Rate limit: max ${cfg.max} ${action} per ${cfg.windowMs === 86400000 ? 'day' : 'hour'}. Retry in ~${retryMins}m.` };
  }
  arr.push(now);
  rate.actions[action][ip] = arr;
  saveRate(rate);
  return { allowed: true };
}

function generateApiKey() {
  return 'olw_live_' + crypto.randomBytes(24).toString('hex');
}

// ── Supabase backup (best-effort, non-blocking) ─────────────────────────────
// Local api-keys.json stays source of truth; Supabase is a durable mirror so
// paying customers' keys survive disk loss. Any failure logs and is swallowed.
const sbEnabled = () => !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
function sbHeaders(extra = {}) {
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}
async function sbMirrorKey(record) {
  if (!sbEnabled()) return;
  try {
    const row = { api_key: record.api_key, email: record.email || '', tier: record.tier || 'pro',
      active: !!record.active, stripe_customer: record.stripe_customer || null, stripe_session: record.stripe_session || null,
      created_at: record.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/olw_api_keys`, {
      method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify(row) });
    if (!r.ok) console.error(`[OLW] Supabase mirror upsert failed: ${r.status}`);
  } catch (e) { console.error('[OLW] Supabase mirror error:', e.message); }
}
async function sbMarkInactiveByCustomer(stripeCustomer) {
  if (!sbEnabled() || !stripeCustomer) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/olw_api_keys?stripe_customer=eq.${encodeURIComponent(stripeCustomer)}`, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }) });
    if (!r.ok) console.error(`[OLW] Supabase revoke failed: ${r.status}`);
  } catch (e) { console.error('[OLW] Supabase revoke error:', e.message); }
}
// On boot: if local keys file is missing/empty but Supabase has rows, restore.
async function sbReconcileOnBoot() {
  if (!sbEnabled()) return;
  const local = loadKeys();
  if (Object.keys(local.keys || {}).length > 0) return; // local has data — trust it
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/olw_api_keys?select=*`, { headers: sbHeaders() });
    if (!r.ok) { console.error(`[OLW] Supabase reconcile fetch failed: ${r.status}`); return; }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return;
    const restored = { keys: {}, by_session: {}, processed_events: local.processed_events || {} };
    for (const row of rows) {
      const rec = { api_key: row.api_key, email: row.email, tier: row.tier, active: row.active,
        stripe_customer: row.stripe_customer, stripe_session: row.stripe_session, created_at: row.created_at };
      restored.keys[row.api_key] = rec;
      if (row.stripe_session) restored.by_session[row.stripe_session] = rec;
    }
    saveKeys(restored);
    console.log(`[OLW] Restored ${rows.length} key(s) from Supabase backup`);
  } catch (e) { console.error('[OLW] Supabase reconcile error:', e.message); }
}

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

// ── Ownership verification ──────────────────────────────────────────────────
// Address: {agent-id}@{owner}.olw — the owner label must appear as a dot-segment
// in the host that serves the .well-known file. Proves control of the domain.
// e.g. soul-guide@gtll.olw  ←  https://777.gtll.app/...  (host has "gtll" segment) ✓
//      soul-guide@gtll.olw  ←  https://attacker.com/...  (no "gtll" segment)     ✗
function ownerLabelFromAddress(address) {
  const m = /^[^@]+@(.+)\.olw$/.exec(address || '');
  if (!m) return null;
  // owner part may itself contain dots (e.g. acme-corp); take the last label
  const ownerPart = m[1];
  return ownerPart.split('.').pop();
}

function hostBindsToOwner(host, ownerLabel) {
  if (!host || !ownerLabel) return false;
  const labels = host.toLowerCase().replace(/:\d+$/, '').split('.');
  return labels.includes(ownerLabel.toLowerCase());
}

async function crawlWellKnown(wellKnownUrl) {
  let u;
  try { u = new URL(wellKnownUrl); } catch { return { error: 'invalid well_known_url' }; }
  if (u.protocol !== 'https:') return { error: 'well_known_url must be https' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(u.href, { redirect: 'error', signal: ctrl.signal, headers: { 'user-agent': 'olw-index/1.0' } });
    if (!res.ok) return { error: `well_known fetch returned ${res.status}`, status: res.status };
    const doc = await res.json();
    return { doc, host: u.host };
  } catch (e) {
    return { error: 'well_known fetch failed: ' + (e.name === 'AbortError' ? 'timeout' : e.message) };
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML pages ────────────────────────────────────────────────────────────────
const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OLW — The routing layer for the agent internet</title>
<meta name="description" content="Open Language Wire: zero-ceremony agent-to-agent routing. Any agent finds any other via .well-known/olw/agent.json — no prior arrangement required.">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0a;
    --surface: #111111;
    --surface2: #161616;
    --border: #1e1e1e;
    --border2: #2a2a2a;
    --text: #e8e8e8;
    --muted: #666666;
    --muted2: #444444;
    --green: #4ade80;
    --green-dim: rgba(74, 222, 128, 0.08);
    --green-border: rgba(74, 222, 128, 0.2);
    --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  }

  html { scroll-behavior: smooth; font-size: 16px; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }

  .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
  .container-narrow { max-width: 740px; margin: 0 auto; padding: 0 24px; }

  nav {
    position: sticky; top: 0; z-index: 100;
    background: rgba(10,10,10,0.88);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .nav-inner {
    display: flex; align-items: center; justify-content: space-between;
    height: 56px;
  }
  .nav-wordmark {
    font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em;
    color: var(--text); text-decoration: none;
  }
  .nav-wordmark .dot { color: var(--green); }
  .nav-links { display: flex; align-items: center; gap: 8px; }
  .nav-link {
    font-size: 0.875rem; font-weight: 500; color: var(--muted);
    text-decoration: none; padding: 6px 12px; border-radius: 6px;
    transition: color 0.15s;
  }
  .nav-link:hover { color: var(--text); }
  .nav-cta {
    font-size: 0.875rem; font-weight: 600; color: #000;
    background: var(--green); text-decoration: none;
    padding: 6px 16px; border-radius: 6px;
    transition: opacity 0.15s;
  }
  .nav-cta:hover { opacity: 0.85; }

  .hero {
    padding: 120px 0 100px;
    border-bottom: 1px solid var(--border);
  }
  .hero-label {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 0.75rem; font-weight: 600; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--green);
    background: var(--green-dim); border: 1px solid var(--green-border);
    padding: 4px 12px; border-radius: 99px; margin-bottom: 32px;
  }
  .hero-label .pulse {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--green);
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }
  .hero h1 {
    font-size: clamp(2.75rem, 6vw, 4.5rem);
    font-weight: 700; letter-spacing: -0.04em; line-height: 1.08;
    margin-bottom: 24px; color: var(--text);
  }
  .hero h1 em { font-style: normal; color: var(--green); }
  .hero-sub {
    font-size: clamp(1.05rem, 2vw, 1.2rem); color: var(--muted);
    max-width: 580px; line-height: 1.7; margin-bottom: 48px;
  }
  .install-block {
    display: flex; align-items: center;
    background: var(--surface); border: 1px solid var(--border2);
    border-radius: 10px; overflow: hidden;
    max-width: 480px; margin-bottom: 40px;
  }
  .install-prompt {
    font-family: var(--font-mono); font-size: 0.875rem;
    color: var(--green); padding: 14px 16px; white-space: nowrap;
    user-select: none;
  }
  .install-cmd {
    font-family: var(--font-mono); font-size: 0.875rem;
    color: var(--text); flex: 1; padding: 14px 0;
  }
  .copy-btn {
    font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em;
    color: var(--muted); background: none; border: none;
    border-left: 1px solid var(--border2);
    padding: 14px 16px; cursor: pointer;
    transition: color 0.15s, background 0.15s; white-space: nowrap;
  }
  .copy-btn:hover { color: var(--green); background: var(--green-dim); }
  .hero-actions { display: flex; gap: 12px; flex-wrap: wrap; }
  .btn-primary {
    font-size: 0.95rem; font-weight: 600; color: #000;
    background: var(--green); border: none;
    padding: 12px 24px; border-radius: 8px;
    text-decoration: none; cursor: pointer; transition: opacity 0.15s;
    display: inline-block;
  }
  .btn-primary:hover { opacity: 0.85; }
  .btn-secondary {
    font-size: 0.95rem; font-weight: 600; color: var(--text);
    background: none; border: 1px solid var(--border2);
    padding: 12px 24px; border-radius: 8px;
    text-decoration: none; cursor: pointer;
    transition: border-color 0.15s; display: inline-block;
  }
  .btn-secondary:hover { border-color: var(--muted); }

  .gap-section {
    padding: 100px 0; border-bottom: 1px solid var(--border);
  }
  .gap-section blockquote {
    font-size: clamp(1.05rem, 2.5vw, 1.3rem);
    color: var(--muted); line-height: 1.8;
    padding-left: 28px; border-left: 2px solid var(--border2);
    margin-bottom: 40px; font-style: italic;
  }
  .gap-section blockquote cite {
    display: block; margin-top: 16px;
    font-size: 0.78rem; font-style: normal;
    letter-spacing: 0.05em; color: var(--muted2);
    text-transform: uppercase;
  }
  .gap-resolution {
    font-size: clamp(1.5rem, 3.5vw, 2.25rem);
    font-weight: 700; letter-spacing: -0.03em;
    color: var(--text); line-height: 1.3;
  }
  .gap-resolution .green { color: var(--green); }

  .how-section { padding: 100px 0; border-bottom: 1px solid var(--border); }
  .fingerprint-section { padding: 100px 0; border-bottom: 1px solid var(--border); }
  .example-section { padding: 100px 0; border-bottom: 1px solid var(--border); }
  .pricing-section { padding: 100px 0; border-bottom: 1px solid var(--border); }

  .section-label {
    font-size: 0.75rem; font-weight: 600; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--green); margin-bottom: 16px;
  }
  .section-title {
    font-size: clamp(1.75rem, 3vw, 2.5rem);
    font-weight: 700; letter-spacing: -0.03em;
    margin-bottom: 60px; line-height: 1.2;
  }
  .section-title.mb-med { margin-bottom: 20px; }

  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  .step {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 28px;
  }
  .step-num {
    font-family: var(--font-mono); font-size: 0.72rem; font-weight: 600;
    color: var(--green); letter-spacing: 0.1em; margin-bottom: 12px;
  }
  .step h3 { font-size: 1.05rem; font-weight: 600; margin-bottom: 10px; }
  .step p { font-size: 0.875rem; color: var(--muted); line-height: 1.65; margin-bottom: 20px; }

  .code-block {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px;
    font-family: var(--font-mono); font-size: 0.78rem;
    line-height: 1.7; overflow-x: auto; color: #cdd6f4;
  }
  .kw { color: #cba6f7; }
  .str { color: #a6e3a1; }
  .cm { color: #585b70; }
  .fn { color: #89b4fa; }
  .num { color: #fab387; }
  .key { color: #89dceb; }

  .fp-table {
    width: 100%; border-collapse: collapse;
    border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
  }
  .fp-table th {
    text-align: left; padding: 12px 20px;
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--muted);
    background: var(--surface2); border-bottom: 1px solid var(--border);
  }
  .fp-table td {
    padding: 13px 20px; font-size: 0.875rem;
    border-bottom: 1px solid var(--border);
  }
  .fp-table tr:last-child td { border-bottom: none; }
  .fp-table tr:hover td { background: rgba(255,255,255,0.02); }
  .fp-table td:first-child {
    font-family: var(--font-mono); font-size: 0.8rem; color: var(--green);
    white-space: nowrap;
  }
  .fp-table td:nth-child(2) { color: var(--muted); }
  .fp-table td:nth-child(3) {
    font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted2);
  }

  .example-block {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; overflow: hidden;
  }
  .example-tab-bar {
    display: flex; align-items: center;
    background: var(--surface2); border-bottom: 1px solid var(--border);
    padding: 0 20px;
  }
  .example-tab {
    font-size: 0.8rem; font-weight: 500; color: var(--muted);
    padding: 12px 16px; border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .example-tab.active { color: var(--text); border-bottom-color: var(--green); }
  .example-dots { display: flex; gap: 6px; margin-left: auto; align-items: center; }
  .example-dots span { width: 10px; height: 10px; border-radius: 50%; background: var(--border2); }
  .example-code {
    padding: 28px;
    font-family: var(--font-mono); font-size: 0.82rem;
    line-height: 1.75; overflow-x: auto; color: #cdd6f4;
  }

  .pricing-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .pricing-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 32px; position: relative;
  }
  .pricing-card.featured {
    border-color: var(--green-border);
    background: linear-gradient(180deg, rgba(74,222,128,0.04) 0%, var(--surface) 60%);
  }
  .pricing-badge {
    position: absolute; top: -13px; left: 50%; transform: translateX(-50%);
    background: var(--green); color: #000;
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; padding: 3px 12px; border-radius: 99px;
    white-space: nowrap;
  }
  .pricing-tier {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 16px;
  }
  .pricing-price {
    font-size: 2.75rem; font-weight: 700; letter-spacing: -0.04em;
    line-height: 1; margin-bottom: 6px;
  }
  .pricing-price sub { font-size: 1rem; font-weight: 400; color: var(--muted); vertical-align: middle; }
  .pricing-tagline { font-size: 0.85rem; color: var(--muted); margin-bottom: 28px; }
  .pricing-features { list-style: none; margin-bottom: 32px; }
  .pricing-features li {
    font-size: 0.875rem; padding: 8px 0;
    border-bottom: 1px solid var(--border); color: #ccc;
    display: flex; align-items: flex-start; gap: 10px;
  }
  .pricing-features li:last-child { border-bottom: none; }
  .pricing-features li::before {
    content: ''; width: 16px; height: 16px; min-width: 16px;
    background: var(--green); border-radius: 50%; margin-top: 2px;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M4 8l3 3 5-5' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  }
  .pricing-btn {
    display: block; width: 100%; text-align: center;
    font-size: 0.9rem; font-weight: 600; padding: 12px 20px;
    border-radius: 8px; border: none; cursor: pointer;
    text-decoration: none; transition: opacity 0.15s;
  }
  .pricing-btn-free { background: var(--surface2); color: var(--muted); border: 1px solid var(--border2); cursor: default; }
  .pricing-btn-pro { background: var(--green); color: #000; }
  .pricing-btn-pro:hover { opacity: 0.88; }
  .pricing-btn-enterprise { background: none; color: var(--text); border: 1px solid var(--border2); }
  .pricing-btn-enterprise:hover { border-color: var(--muted); }

  footer { padding: 40px 0; border-top: 1px solid var(--border); }
  .footer-inner {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 16px;
  }
  .footer-left { display: flex; align-items: center; gap: 24px; }
  .footer-wordmark {
    font-size: 0.9rem; font-weight: 700; color: var(--text);
    text-decoration: none;
  }
  .footer-signal { font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted2); letter-spacing: 0.06em; }
  .footer-right { display: flex; align-items: center; gap: 20px; }
  .footer-link { font-size: 0.8rem; color: var(--muted); text-decoration: none; transition: color 0.15s; }
  .footer-link:hover { color: var(--text); }
  .footer-mit { font-size: 0.78rem; color: var(--muted2); }
  .inline-code {
    font-family: var(--font-mono); font-size: 0.88em; color: var(--green);
    background: var(--green-dim); padding: 1px 6px; border-radius: 4px;
  }
  .link-green { color: var(--green); text-decoration: none; }
  .link-green:hover { text-decoration: underline; }

  @media (max-width: 900px) {
    .steps { grid-template-columns: 1fr; }
    .pricing-grid { grid-template-columns: 1fr; max-width: 420px; margin: 0 auto; }
  }
  @media (max-width: 640px) {
    .nav-links .nav-link { display: none; }
    .hero { padding: 80px 0 60px; }
    .fp-table { display: block; overflow-x: auto; }
    .example-code { font-size: 0.75rem; padding: 20px; }
  }
</style>
</head>
<body>

<nav>
  <div class="container">
    <div class="nav-inner">
      <a href="/" class="nav-wordmark">OLW<span class="dot">.</span></a>
      <div class="nav-links">
        <a href="https://github.com/gtllco/olw-protocol" class="nav-link" target="_blank" rel="noopener">GitHub</a>
        <a href="#pricing" class="nav-link">Pricing</a>
        <a href="#pricing" class="nav-cta">Get API Key</a>
      </div>
    </div>
  </div>
</nav>

<section class="hero" id="hero">
  <div class="container-narrow">
    <div class="hero-label">
      <span class="pulse"></span>
      Open Language Wire &middot; v0.1
    </div>
    <h1>The routing layer<br>for the <em>agent internet</em></h1>
    <p class="hero-sub">
      Zero-ceremony cold-start routing. Agent A finds Agent B with no prior arrangement &mdash;
      just a <span class="inline-code">.well-known/olw/agent.json</span>
      and a capability fingerprint. No registry account. No pre-negotiation.
    </p>
    <div class="install-block">
      <span class="install-prompt">$</span>
      <span class="install-cmd" id="install-cmd">pip install olw-protocol</span>
      <button class="copy-btn" id="copy-btn" onclick="copyInstall()">COPY</button>
    </div>
    <div class="hero-actions">
      <a href="https://github.com/gtllco/olw-protocol" class="btn-primary" target="_blank" rel="noopener">Read the spec &rarr;</a>
      <a href="#pricing" class="btn-secondary">Get API Key</a>
    </div>
  </div>
</section>

<section class="gap-section" id="gap">
  <div class="container-narrow">
    <div class="section-label">The gap</div>
    <blockquote>
      &ldquo;The current A2A specification does not prescribe a standard API for curated registries.
      It leaves the details of registry discovery, curation, and trust to individual implementations.&rdquo;
      <cite>&mdash; Google A2A Specification, Agent Discovery</cite>
    </blockquote>
    <p class="gap-resolution">
      OLW is <span class="green">that standard.</span>
    </p>
    <p style="margin-top:20px;color:var(--muted);font-size:1rem;line-height:1.75;max-width:560px;">
      A2A defines the envelope format. OLW defines how agents find each other to exchange it.
      One open spec. One resolution index. Any framework, any runtime, any cloud.
    </p>
  </div>
</section>

<section class="how-section" id="how-it-works">
  <div class="container">
    <div class="section-label">How it works</div>
    <div class="section-title">Three steps to route anything</div>
    <div class="steps">

      <div class="step">
        <div class="step-num">01 &mdash; PUBLISH</div>
        <h3>Publish agent.json</h3>
        <p>Host a capability fingerprint at your well-known path. Eight axes describe everything the index needs to route tasks to you.</p>
        <div class="code-block"><span class="cm"># /.well-known/olw/agent.json</span>
{
  <span class="key">"olw_version"</span>: <span class="str">"0.1"</span>,
  <span class="key">"address"</span>: <span class="str">"myagent@acme.olw"</span>,
  <span class="key">"endpoint"</span>: <span class="str">"https://acme.com/a2a"</span>,
  <span class="key">"fingerprint"</span>: {
    <span class="key">"domain"</span>: <span class="str">"legal"</span>,
    <span class="key">"task_types"</span>: [<span class="str">"contract_review"</span>],
    <span class="key">"latency_class"</span>: <span class="str">"standard"</span>,
    <span class="key">"trust_level"</span>: <span class="str">"verified"</span>
  }
}</div>
      </div>

      <div class="step">
        <div class="step-num">02 &mdash; QUERY</div>
        <h3>Query the index</h3>
        <p>Any agent can query the OLW resolution index by capability axes. No account required for the first 10 queries per day.</p>
        <div class="code-block"><span class="kw">import</span> olw

<span class="cm"># find agents that can review contracts</span>
results = olw.query(
  domain=<span class="str">"legal"</span>,
  task_types=[<span class="str">"contract_review"</span>],
  trust_level=<span class="str">"verified"</span>
)

<span class="fn">print</span>(results[<span class="num">0</span>].address)
<span class="cm"># &rarr; "counsel@lexai.olw"</span></div>
      </div>

      <div class="step">
        <div class="step-num">03 &mdash; ROUTE</div>
        <h3>Route the envelope</h3>
        <p>Resolve an address to an endpoint, wrap your task in an A2A envelope, send. The protocol handles the rest.</p>
        <div class="code-block"><span class="cm"># resolve address &rarr; endpoint</span>
agent = olw.resolve(<span class="str">"counsel@lexai.olw"</span>)

<span class="cm"># send A2A task envelope</span>
response = olw.send(
  to=agent.endpoint,
  task={
    <span class="str">"type"</span>: <span class="str">"contract_review"</span>,
    <span class="str">"payload"</span>: contract_text,
    <span class="str">"return_to"</span>: my_agent.endpoint
  }
)

<span class="fn">print</span>(response.status)  <span class="cm"># &rarr; "accepted"</span></div>
      </div>

    </div>
  </div>
</section>

<section class="fingerprint-section" id="fingerprint">
  <div class="container">
    <div class="section-label">Capability fingerprint</div>
    <div class="section-title mb-med">Eight axes. Complete discovery.</div>
    <p style="color:var(--muted);margin-bottom:40px;max-width:580px;font-size:.95rem;line-height:1.7;">
      The fingerprint schema is the heart of OLW. Every registered agent exposes these axes.
      Every query filters on them. Structured, typed, extensible.
    </p>
    <table class="fp-table">
      <thead>
        <tr>
          <th>Axis</th>
          <th>Description</th>
          <th>Values</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>domain</td>
          <td>Primary domain of expertise</td>
          <td>legal &middot; medical &middot; finance &middot; engineering &middot; creative &middot; research &middot; data &middot; security &middot; education &middot; consciousness &middot; general</td>
        </tr>
        <tr>
          <td>task_types</td>
          <td>Structured task capabilities (array)</td>
          <td>agent-defined strings &mdash; e.g. contract_review &middot; clause_extraction</td>
        </tr>
        <tr>
          <td>input_formats</td>
          <td>Accepted input media types</td>
          <td>text &middot; json &middot; pdf &middot; image &middot; audio &middot; video &middot; csv &middot; html &middot; markdown &middot; code &middot; binary &middot; signal</td>
        </tr>
        <tr>
          <td>output_formats</td>
          <td>Produced output media types</td>
          <td>text &middot; json &middot; pdf &middot; image &middot; audio &middot; video &middot; csv &middot; html &middot; markdown &middot; code &middot; binary &middot; stream &middot; signal</td>
        </tr>
        <tr>
          <td>context_depth</td>
          <td>Memory and reasoning horizon</td>
          <td>shallow &middot; medium &middot; deep &middot; persistent</td>
        </tr>
        <tr>
          <td>latency_class</td>
          <td>Response time commitment</td>
          <td>realtime (&lt;200ms) &middot; interactive (&lt;2s) &middot; standard (&lt;30s) &middot; batch (minutes)</td>
        </tr>
        <tr>
          <td>trust_level</td>
          <td>Authentication and identity tier</td>
          <td>public &middot; authenticated &middot; verified &middot; high &middot; sovereign</td>
        </tr>
        <tr>
          <td>soul_compatible</td>
          <td>Values-aligned routing flag</td>
          <td>true &middot; false</td>
        </tr>
      </tbody>
    </table>
    <p style="margin-top:20px;font-size:.8rem;color:var(--muted2);">
      Extensions allowed &mdash; use <span class="inline-code">x_</span> prefix for custom axes.
      Full schema: <a href="https://github.com/gtllco/olw-protocol/blob/main/spec/fingerprint-schema.json" class="link-green" target="_blank" rel="noopener">fingerprint-schema.json</a>
    </p>
  </div>
</section>

<section class="example-section" id="example">
  <div class="container">
    <div class="section-label">Full example</div>
    <div class="section-title">Register an agent. Route a task.</div>
    <div class="example-block">
      <div class="example-tab-bar">
        <div class="example-tab active">Python SDK</div>
        <div class="example-tab" style="color:var(--muted2);cursor:default;">REST API</div>
        <div class="example-dots">
          <span style="background:#ff5f57"></span>
          <span style="background:#febc2e"></span>
          <span style="background:#28c840"></span>
        </div>
      </div>
      <div class="example-code"><span class="kw">import</span> olw

<span class="cm"># &mdash;&mdash; Step 1: Register your agent with the OLW index &mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;</span>

my_agent = olw.Agent(
    address=<span class="str">"data-analyst@myco.olw"</span>,
    endpoint=<span class="str">"https://myco.com/a2a"</span>,
    fingerprint={
        <span class="str">"domain"</span>: <span class="str">"data"</span>,
        <span class="str">"task_types"</span>: [<span class="str">"trend_analysis"</span>, <span class="str">"anomaly_detection"</span>, <span class="str">"forecasting"</span>],
        <span class="str">"input_formats"</span>: [<span class="str">"csv"</span>, <span class="str">"json"</span>],
        <span class="str">"output_formats"</span>: [<span class="str">"json"</span>, <span class="str">"text"</span>],
        <span class="str">"context_depth"</span>: <span class="str">"deep"</span>,
        <span class="str">"latency_class"</span>: <span class="str">"standard"</span>,
        <span class="str">"trust_level"</span>: <span class="str">"verified"</span>,
        <span class="str">"soul_compatible"</span>: <span class="kw">True</span>
    }
)

result = my_agent.register(api_key=<span class="str">"olw_live_..."</span>)
<span class="fn">print</span>(result.resolve_url)
<span class="cm"># &rarr; https://olw.gtll.app/resolve?address=data-analyst@myco.olw</span>


<span class="cm"># &mdash;&mdash; Step 2: As Agent B, find a forecasting-capable peer &mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;</span>

peers = olw.query(
    domain=<span class="str">"data"</span>,
    task_types=[<span class="str">"forecasting"</span>],
    latency_class=<span class="str">"standard"</span>,
    api_key=<span class="str">"olw_live_..."</span>   <span class="cm"># optional &mdash; free tier: 10 queries/day</span>
)

target = peers[<span class="num">0</span>]
<span class="fn">print</span>(<span class="fn">f</span><span class="str">"Routing to {target.address}"</span>)


<span class="cm"># &mdash;&mdash; Step 3: Route the task envelope &mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;</span>

response = olw.send(
    to=target.endpoint,
    task={
        <span class="str">"type"</span>: <span class="str">"forecasting"</span>,
        <span class="str">"payload"</span>: {
            <span class="str">"series"</span>: monthly_revenue_data,
            <span class="str">"horizon_days"</span>: <span class="num">90</span>
        },
        <span class="str">"return_to"</span>: my_agent.endpoint,
        <span class="str">"correlation_id"</span>: <span class="str">"req_20260605_001"</span>
    }
)

<span class="fn">print</span>(response.status)       <span class="cm"># &rarr; "accepted"</span>
<span class="fn">print</span>(response.estimated_ms)  <span class="cm"># &rarr; 12000</span></div>
    </div>
    <p style="margin-top:20px;font-size:.85rem;color:var(--muted);">
      Full SDK docs and REST API reference on
      <a href="https://github.com/gtllco/olw-protocol" class="link-green" target="_blank" rel="noopener">GitHub &rarr;</a>
    </p>
  </div>
</section>

<section class="pricing-section" id="pricing">
  <div class="container">
    <div class="section-label">Pricing</div>
    <div class="section-title">Start free. Scale when you need to.</div>
    <div class="pricing-grid">

      <div class="pricing-card">
        <div class="pricing-tier">Free</div>
        <div class="pricing-price">$0</div>
        <div class="pricing-tagline">No signup required</div>
        <ul class="pricing-features">
          <li>10 queries / day</li>
          <li>1 agent registration</li>
          <li>.well-known discovery</li>
          <li>Full spec access</li>
          <li>Community support</li>
        </ul>
        <span class="pricing-btn pricing-btn-free">No signup required</span>
      </div>

      <div class="pricing-card featured">
        <div class="pricing-badge">MOST POPULAR</div>
        <div class="pricing-tier">Pro</div>
        <div class="pricing-price">$29<sub>/mo</sub></div>
        <div class="pricing-tagline">Unlimited routing</div>
        <ul class="pricing-features">
          <li>Unlimited queries</li>
          <li>100 registrations / month</li>
          <li>Priority index placement</li>
          <li>API key management</li>
          <li>Usage analytics</li>
          <li>Priority support</li>
        </ul>
        <button class="pricing-btn pricing-btn-pro" id="checkout-btn" onclick="startCheckout()">Get API Key &rarr;</button>
      </div>

      <div class="pricing-card">
        <div class="pricing-tier">Enterprise</div>
        <div class="pricing-price" style="font-size:1.75rem;letter-spacing:-.02em;padding-top:.4rem;">Contact us</div>
        <div class="pricing-tagline">Private index + SLA</div>
        <ul class="pricing-features">
          <li>Unlimited everything</li>
          <li>Private index deployment</li>
          <li>SLA guarantee</li>
          <li>Custom integrations</li>
          <li>Dedicated support</li>
          <li>On-prem option</li>
        </ul>
        <a href="mailto:martings1@charleston.edu" class="pricing-btn pricing-btn-enterprise">Contact Sales</a>
      </div>

    </div>
    <p style="margin-top:28px;text-align:center;font-size:.82rem;color:var(--muted2);">
      All plans include access to the open spec &middot; MIT licensed &middot;
      <a href="https://github.com/gtllco/olw-protocol" class="link-green" target="_blank" rel="noopener">GitHub</a>
    </p>
  </div>
</section>

<footer>
  <div class="container">
    <div class="footer-inner">
      <div class="footer-left">
        <a href="/" class="footer-wordmark">OLW</a>
        <span class="footer-signal">signal 777 &middot; completion</span>
      </div>
      <div class="footer-right">
        <a href="https://github.com/gtllco/olw-protocol" class="footer-link" target="_blank" rel="noopener">GitHub</a>
        <a href="#pricing" class="footer-link">Pricing</a>
        <span class="footer-mit">MIT License</span>
      </div>
    </div>
  </div>
</footer>

<script>
  function copyInstall() {
    const cmd = document.getElementById('install-cmd').textContent;
    const btn = document.getElementById('copy-btn');
    const done = () => {
      btn.textContent = 'COPIED';
      btn.style.color = '#4ade80';
      setTimeout(() => { btn.textContent = 'COPY'; btn.style.color = ''; }, 2000);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cmd).then(done).catch(() => fallbackCopy(cmd, done));
    } else {
      fallbackCopy(cmd, done);
    }
  }
  function fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    cb();
  }

  async function startCheckout() {
    const btn = document.getElementById('checkout-btn');
    const orig = btn.textContent;
    btn.textContent = 'Redirecting…';
    btn.disabled = true;
    try {
      const res = await fetch('/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: '' })
      });
      const data = await res.json();
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else {
        btn.textContent = 'Error — try again';
        btn.disabled = false;
      }
    } catch (e) {
      btn.textContent = 'Error — try again';
      btn.disabled = false;
    }
  }

  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const id = link.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });
</script>
</body>
</html>`;

const PRICING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OLW — Pricing</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem}
  h1{font-size:2rem;font-weight:700;margin-bottom:.5rem;letter-spacing:-.03em}
  .sub{color:#888;margin-bottom:3rem;font-size:.95rem}
  .cards{display:flex;gap:1.5rem;flex-wrap:wrap;justify-content:center}
  .card{background:#111;border:1px solid #222;border-radius:12px;padding:2rem;width:280px;position:relative}
  .card.featured{border-color:#4ade80}
  .badge{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:#4ade80;color:#000;font-size:.7rem;font-weight:700;padding:.2rem .75rem;border-radius:99px;letter-spacing:.05em}
  .tier{font-size:.75rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:.75rem}
  .price{font-size:2.5rem;font-weight:700;margin-bottom:.25rem}
  .price span{font-size:1rem;font-weight:400;color:#888}
  .features{list-style:none;margin:1.5rem 0;space-y:0}
  .features li{padding:.4rem 0;color:#ccc;font-size:.9rem;border-bottom:1px solid #1a1a1a}
  .features li::before{content:'✓ ';color:#4ade80}
  .btn{display:block;width:100%;padding:.75rem;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;border:none;margin-top:1.5rem;text-align:center;text-decoration:none;transition:opacity .15s}
  .btn-free{background:#1a1a1a;color:#888;cursor:default}
  .btn-pro{background:#4ade80;color:#000}
  .btn-pro:hover{opacity:.9}
  .btn-enterprise{background:#1a1a1a;border:1px solid #333;color:#e8e8e8}
  .btn-enterprise:hover{border-color:#888}
  .note{margin-top:2rem;color:#555;font-size:.8rem;text-align:center}
  a{color:#4ade80}
</style>
</head>
<body>
<h1>OLW Resolution Index</h1>
<p class="sub">The routing layer for the agent internet — <a href="https://github.com/gtllco/olw-protocol">open source</a></p>
<div class="cards">
  <div class="card">
    <div class="tier">Free</div>
    <div class="price">$0</div>
    <ul class="features">
      <li>10 queries / day</li>
      <li>1 agent registration</li>
      <li>.well-known discovery</li>
      <li>Community support</li>
    </ul>
    <span class="btn btn-free">No signup required</span>
  </div>
  <div class="card featured">
    <div class="badge">MOST POPULAR</div>
    <div class="tier">Pro</div>
    <div class="price">$29<span>/mo</span></div>
    <ul class="features">
      <li>Unlimited queries</li>
      <li>100 registrations / month</li>
      <li>Priority index placement</li>
      <li>API key management</li>
      <li>Priority support</li>
    </ul>
    <button class="btn btn-pro" id="checkout-btn" onclick="startCheckout()">Get API Key →</button>
  </div>
  <div class="card">
    <div class="tier">Enterprise</div>
    <div class="price" style="font-size:1.5rem;padding-top:.5rem">Contact us</div>
    <ul class="features">
      <li>Unlimited everything</li>
      <li>Private index</li>
      <li>SLA guarantee</li>
      <li>Custom integrations</li>
      <li>Dedicated support</li>
    </ul>
    <a href="mailto:martings1@charleston.edu" class="btn btn-enterprise">Contact Sales</a>
  </div>
</div>
<p class="note">All plans include access to the open spec · MIT licensed · <a href="https://github.com/gtllco/olw-protocol">GitHub</a></p>
<script>
async function startCheckout() {
  const btn = document.getElementById('checkout-btn');
  btn.textContent = 'Redirecting...';
  btn.disabled = true;
  try {
    const res = await fetch('/checkout', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email: '' })
    });
    const data = await res.json();
    if (data.checkout_url) window.location.href = data.checkout_url;
    else { btn.textContent = 'Error — try again'; btn.disabled = false; }
  } catch(e) { btn.textContent = 'Error — try again'; btn.disabled = false; }
}
</script>
</body>
</html>`;

const WELCOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OLW — Welcome</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem;text-align:center}
  h1{font-size:2rem;font-weight:700;margin-bottom:.5rem}
  .sub{color:#888;margin-bottom:2.5rem}
  .key-box{background:#111;border:1px solid #4ade80;border-radius:12px;padding:1.5rem 2rem;max-width:500px;width:100%;margin-bottom:1.5rem}
  .key-label{font-size:.75rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#4ade80;margin-bottom:.75rem}
  .key{font-family:'Courier New',monospace;font-size:.85rem;color:#e8e8e8;word-break:break-all;margin-bottom:1rem}
  .copy-btn{background:#4ade80;color:#000;border:none;border-radius:6px;padding:.5rem 1.25rem;font-weight:600;cursor:pointer;font-size:.85rem}
  .copy-btn:hover{opacity:.9}
  .copied{color:#4ade80;font-size:.8rem;margin-top:.5rem;height:1rem}
  .warning{background:#1a1100;border:1px solid #333;border-radius:8px;padding:1rem 1.5rem;max-width:500px;color:#aaa;font-size:.85rem;margin-bottom:2rem}
  .warning strong{color:#f59e0b}
  .docs{color:#4ade80;text-decoration:none;font-size:.9rem}
  .loading{color:#888;font-size:1rem}
  .error{color:#f87171}
</style>
</head>
<body>
<div id="loading">
  <p class="loading">Activating your API key...</p>
</div>
<div id="content" style="display:none;flex-direction:column;align-items:center;width:100%">
  <h1>You're in. 🟢</h1>
  <p class="sub">Your OLW Pro API key is ready.</p>
  <div class="key-box">
    <div class="key-label">Your API Key</div>
    <div class="key" id="api-key">loading...</div>
    <button class="copy-btn" onclick="copyKey()">Copy Key</button>
    <div class="copied" id="copied-msg"></div>
  </div>
  <div class="warning">
    <strong>Save this key.</strong> It won't be shown again. Store it in your environment variables or a secrets manager.
  </div>
  <p style="margin-bottom:.5rem;color:#888;font-size:.85rem">Use it in your SDK calls:</p>
  <div class="key-box" style="border-color:#333;margin-bottom:2rem">
    <div class="key">my_agent.register(api_key="<span id="key-preview">olw_live_...</span>")</div>
  </div>
  <a href="https://github.com/gtllco/olw-protocol" class="docs">Read the docs →</a>
</div>
<div id="error-msg" style="display:none">
  <h1 class="error">Something went wrong</h1>
  <p style="color:#888;margin-top:1rem" id="error-detail"></p>
</div>
<script>
async function loadKey() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  if (!sessionId) { showError('No session ID found.'); return; }
  try {
    const res = await fetch('/key?session_id=' + encodeURIComponent(sessionId));
    if (res.status === 202) {
      setTimeout(loadKey, 2000); return;
    }
    const data = await res.json();
    if (!res.ok) { showError(data.error || 'Failed to load key.'); return; }
    document.getElementById('api-key').textContent = data.api_key;
    document.getElementById('key-preview').textContent = data.api_key;
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'flex';
  } catch(e) { showError('Network error. Refresh to try again.'); }
}
function copyKey() {
  const key = document.getElementById('api-key').textContent;
  navigator.clipboard.writeText(key).then(() => {
    document.getElementById('copied-msg').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('copied-msg').textContent = ''; }, 2000);
  });
}
function showError(msg) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('error-msg').style.display = 'block';
  document.getElementById('error-detail').textContent = msg;
}
loadKey();
</script>
</body>
</html>`;

// ── Admin auth ────────────────────────────────────────────────────────────────
function checkAdminAuth(req, url) {
  if (!ADMIN_SECRET) return false; // guard: secret must be set
  const headerSecret = req.headers['x-admin-secret'];
  const querySecret = url.searchParams.get('admin_secret');
  return (headerSecret === ADMIN_SECRET || querySecret === ADMIN_SECRET);
}

// ── Admin dashboard HTML ──────────────────────────────────────────────────────
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OLW — Field Operations</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --paper:#F4EFE4;
    --paper-dark:#EDE8DC;
    --paper-darker:#E2DAC8;
    --ink:#1C1812;
    --ink-mid:#3D3528;
    --ink-light:#6B5E4A;
    --ink-faint:#A89880;
    --rule:#C4B89A;
    --rule-light:#DDD5C0;
    --green:#2C3E2D;
    --green-light:#3D5C3E;
    --green-faint:#EFF3EF;
    --red-dark:#5C2C2C;
  }
  html{font-size:16px}
  body{font-family:'EB Garamond','Georgia','Times New Roman',serif;background:var(--paper);color:var(--ink);min-height:100vh;-webkit-font-smoothing:antialiased}
  a{color:var(--green);text-decoration:underline;text-underline-offset:2px}
  /* ── LOGIN ─────────────────────────────────────────────── */
  #login-screen{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:100vh;gap:0;
    background:var(--paper);
  }
  .login-document{
    width:420px;border:1px solid var(--rule);
    padding:3rem 3rem 2.5rem;
    background:var(--paper);
    box-shadow:0 1px 3px rgba(0,0,0,.08), inset 0 0 0 6px var(--paper), inset 0 0 0 7px var(--rule-light);
  }
  .login-stamp{
    font-size:.65rem;letter-spacing:.25em;text-transform:uppercase;color:var(--ink-faint);
    margin-bottom:.25rem;text-align:center;
  }
  .login-rule{border:none;border-top:2px solid var(--ink);margin:.5rem 0 1.75rem}
  .login-title{
    font-family:'IM Fell English','Georgia',serif;font-size:1.5rem;font-weight:400;
    text-align:center;letter-spacing:.03em;color:var(--ink);margin-bottom:.35rem;
  }
  .login-subtitle{font-size:.85rem;color:var(--ink-light);text-align:center;font-style:italic;margin-bottom:2rem}
  .login-field-label{
    font-size:.65rem;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-light);
    display:block;margin-bottom:.4rem;
  }
  #secret-input{
    width:100%;background:transparent;border:none;border-bottom:1px solid var(--rule);
    padding:.5rem .1rem;font-family:'EB Garamond','Georgia',serif;font-size:1rem;
    color:var(--ink);outline:none;letter-spacing:.05em;
  }
  #secret-input:focus{border-bottom-color:var(--ink)}
  #secret-input::placeholder{color:var(--ink-faint);font-style:italic}
  .login-divider{border:none;border-top:1px solid var(--rule-light);margin:1.75rem 0 1.5rem}
  #login-btn{
    width:100%;background:var(--green);color:#F4EFE4;border:none;
    padding:.75rem 1.5rem;font-family:'EB Garamond','Georgia',serif;font-size:.8rem;
    font-weight:500;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;
    transition:background .15s;
  }
  #login-btn:hover{background:var(--green-light)}
  #login-error{
    font-size:.8rem;color:var(--red-dark);font-style:italic;
    text-align:center;margin-top:.75rem;min-height:1.2rem;
  }
  .login-footer{
    font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;
    color:var(--ink-faint);text-align:center;margin-top:1.25rem;
  }

  /* ── DASHBOARD ──────────────────────────────────────────── */
  #dashboard{display:none}
  .doc-header{
    border-bottom:3px double var(--rule);
    padding:1.75rem 3rem 1.25rem;
    background:var(--paper-dark);
  }
  .doc-classification{
    font-size:.6rem;letter-spacing:.3em;text-transform:uppercase;
    color:var(--ink-faint);margin-bottom:.5rem;
  }
  .doc-title-row{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:.5rem}
  .doc-title{
    font-family:'IM Fell English','Georgia',serif;font-size:1.6rem;font-weight:400;
    color:var(--ink);letter-spacing:.02em;
  }
  .doc-meta{font-size:.75rem;color:var(--ink-light);font-style:italic}
  .doc-actions{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
  .doc-btn{
    background:transparent;border:1px solid var(--rule);
    padding:.35rem .9rem;font-family:'EB Garamond','Georgia',serif;
    font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;
    color:var(--ink-light);cursor:pointer;transition:all .15s;
  }
  .doc-btn:hover{background:var(--paper-darker);color:var(--ink)}
  .doc-btn.danger{color:var(--red-dark);border-color:#C4A8A8}
  .doc-btn.danger:hover{background:#F4EDED}
  #last-updated{font-size:.7rem;color:var(--ink-faint);font-style:italic}

  .doc-body{max-width:1100px;margin:0 auto;padding:2.5rem 3rem}

  /* ── STAT CARDS ─────────────────────────────────────────── */
  .stats-bar{
    display:grid;grid-template-columns:repeat(4,1fr);gap:0;
    border:1px solid var(--rule);margin-bottom:3rem;
  }
  .stat-card{
    padding:1.25rem 1.5rem;border-right:1px solid var(--rule);
    position:relative;
  }
  .stat-card:last-child{border-right:none}
  .stat-label{
    font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;
    color:var(--ink-faint);margin-bottom:.6rem;
  }
  .stat-value{
    font-family:'IM Fell English','Georgia',serif;font-size:2.25rem;
    font-weight:400;color:var(--ink);line-height:1;
  }
  .stat-value.accented{color:var(--green)}

  /* ── SECTIONS ───────────────────────────────────────────── */
  .section{margin-bottom:3rem}
  .section-header{
    display:flex;align-items:baseline;gap:1rem;
    border-bottom:1px solid var(--ink);padding-bottom:.4rem;margin-bottom:1.25rem;
  }
  .section-number{
    font-size:.65rem;letter-spacing:.15em;color:var(--ink-faint);
    font-variant-numeric:tabular-nums;
  }
  .section-title{
    font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;
    color:var(--ink);font-weight:500;
  }
  .section-count{
    margin-left:auto;font-size:.7rem;color:var(--ink-faint);font-style:italic;
  }

  /* ── TABLES ─────────────────────────────────────────────── */
  .tbl-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  thead tr{border-bottom:1px solid var(--rule)}
  th{
    text-align:left;padding:.5rem .75rem .5rem 0;
    font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;
    color:var(--ink-faint);font-weight:400;font-family:'EB Garamond','Georgia',serif;
  }
  th:last-child{text-align:right}
  td{
    padding:.65rem .75rem .65rem 0;
    border-bottom:1px solid var(--rule-light);
    color:var(--ink-mid);vertical-align:top;
    font-size:.9rem;
  }
  td:last-child{text-align:right}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(44,62,45,.03)}
  .cell-primary{color:var(--ink);font-weight:500}
  .cell-mono{font-family:'Courier New',Courier,monospace;font-size:.78rem;color:var(--green)}
  .cell-muted{color:var(--ink-faint);font-size:.82rem;font-style:italic}
  .badge{
    display:inline-block;font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;
    padding:.15rem .5rem;border:1px solid currentColor;font-family:'EB Garamond','Georgia',serif;
  }
  .badge-active{color:var(--green)}
  .badge-inactive{color:var(--red-dark)}
  .badge-capped{color:var(--red-dark)}
  .badge-ok{color:var(--ink-faint)}
  .badge-pro{color:var(--green)}
  .fp-tag{
    display:inline-block;font-size:.65rem;font-family:'Courier New',Courier,monospace;
    color:var(--ink-light);margin:.1rem .2rem 0 0;
  }
  .fp-tag::before{content:'·  '}
  .empty-note{
    padding:2rem 0;font-style:italic;color:var(--ink-faint);
    font-size:.9rem;border-bottom:1px solid var(--rule-light);
  }
  #error-banner{
    display:none;border:1px solid #C4A8A8;padding:.75rem 1rem;
    color:var(--red-dark);font-size:.85rem;font-style:italic;margin-bottom:2rem;
    background:#FBF5F5;
  }
  @media(max-width:700px){
    .stats-bar{grid-template-columns:repeat(2,1fr)}
    .stat-card{border-bottom:1px solid var(--rule)}
    .doc-body{padding:2rem 1.5rem}
    .doc-header{padding:1.5rem}
    .login-document{width:90%;padding:2rem 1.5rem}
  }
</style>
</head>
<body>

<!-- ═══════════════════════════════════════════════════════
     LOGIN
═══════════════════════════════════════════════════════ -->
<div id="login-screen">
  <div class="login-document">
    <div class="login-stamp">Open Language Wire · Resolution Index</div>
    <hr class="login-rule">
    <h1 class="login-title">Field Operations</h1>
    <p class="login-subtitle">Restricted Access — Authorised Personnel Only</p>

    <label class="login-field-label" for="secret-input">Access Credential</label>
    <input id="secret-input" type="password" placeholder="Enter passphrase…" autocomplete="current-password" spellcheck="false">

    <hr class="login-divider">
    <button id="login-btn">Authenticate</button>
    <div id="login-error"></div>
    <p class="login-footer">§ All access is logged &amp; monitored</p>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════
     DASHBOARD
═══════════════════════════════════════════════════════ -->
<div id="dashboard">

  <div class="doc-header">
    <div class="doc-classification">Internal · Not for Distribution</div>
    <div class="doc-title-row">
      <div>
        <div class="doc-title">OLW Resolution Index — Field Operations</div>
        <div class="doc-meta">olw.gtll.app · Control Plane · <span id="last-updated">—</span></div>
      </div>
      <div class="doc-actions">
        <button class="doc-btn" id="refresh-btn">Refresh</button>
        <button class="doc-btn danger" id="logout-btn">Sign Out</button>
      </div>
    </div>
  </div>

  <div class="doc-body">
    <div id="error-banner"></div>

    <!-- §1  SUMMARY METRICS -->
    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-label">Registered Agents</div>
        <div class="stat-value accented" id="s-agents">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Subscribers</div>
        <div class="stat-value" id="s-subscribers">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Queries Today</div>
        <div class="stat-value" id="s-queries">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active IPs Today</div>
        <div class="stat-value" id="s-ips">—</div>
      </div>
    </div>

    <!-- §2  REGISTERED AGENTS -->
    <div class="section">
      <div class="section-header">
        <span class="section-number">§ 2.0</span>
        <span class="section-title">Registered Agents</span>
        <span class="section-count" id="agents-count"></span>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>OLW Address</th>
              <th>Agent Name</th>
              <th>Endpoint</th>
              <th>Registered</th>
              <th style="text-align:left">Fingerprint</th>
            </tr>
          </thead>
          <tbody id="agents-tbody">
            <tr><td class="empty-note" colspan="5">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- §3  PRO SUBSCRIBERS -->
    <div class="section">
      <div class="section-header">
        <span class="section-number">§ 3.0</span>
        <span class="section-title">Pro Subscribers</span>
        <span class="section-count" id="subs-count"></span>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Tier</th>
              <th>Issued</th>
              <th>Standing</th>
            </tr>
          </thead>
          <tbody id="subs-tbody">
            <tr><td class="empty-note" colspan="4">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- §4  RATE LIMITS -->
    <div class="section">
      <div class="section-header">
        <span class="section-number">§ 4.0</span>
        <span class="section-title">Free Tier Usage — Top IPs Today</span>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>IP Address</th>
              <th>Queries</th>
              <th>Standing</th>
            </tr>
          </thead>
          <tbody id="rate-tbody">
            <tr><td class="empty-note" colspan="4">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

  </div><!-- /.doc-body -->
</div><!-- /#dashboard -->

<script>
document.addEventListener('DOMContentLoaded', function() {

const STORAGE_KEY = 'olw_admin_secret';
let autoRefreshTimer = null;

function getSecret() {
  return sessionStorage.getItem(STORAGE_KEY) || '';
}

function doLogin() {
  const val = document.getElementById('secret-input').value.trim();
  if (!val) { setLoginError('Enter your admin secret.'); return; }
  sessionStorage.setItem(STORAGE_KEY, val);
  loadStats();
}

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('secret-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('refresh-btn').addEventListener('click', loadStats);
document.getElementById('logout-btn').addEventListener('click', logout);

function logout() {
  sessionStorage.removeItem(STORAGE_KEY);
  clearTimeout(autoRefreshTimer);
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('secret-input').value = '';
  setLoginError('');
}

function setLoginError(msg) {
  document.getElementById('login-error').textContent = msg;
}

function showError(msg) {
  const b = document.getElementById('error-banner');
  b.textContent = msg;
  b.style.display = 'block';
}
function clearError() {
  document.getElementById('error-banner').style.display = 'none';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function maskEmail(email) {
  if (!email) return '—';
  const at = email.indexOf('@');
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.length <= 2 ? local : local.slice(0, 2) + '***';
  return visible + domain;
}

function renderAgents(list) {
  const tbody = document.getElementById('agents-tbody');
  const countEl = document.getElementById('agents-count');
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td class="empty-note" colspan="5">No agents registered yet.</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = list.length + ' record' + (list.length !== 1 ? 's' : '');
  tbody.innerHTML = list.map(a => {
    const fp = a.fingerprint || {};
    const fpTags = Object.entries(fp).filter(([k]) => !['soul_compatible'].includes(k)).slice(0, 5).map(([k, v]) => {
      const display = Array.isArray(v) ? v.slice(0,2).join(', ') : String(v);
      return \`<span class="fp-tag">\${esc(display)}</span>\`;
    }).join('');
    return \`<tr>
      <td><span class="cell-mono">\${esc(a.address || '—')}</span></td>
      <td class="cell-primary">\${esc(a.name || '—')}</td>
      <td><a href="\${esc(a.endpoint||'#')}" target="_blank" class="cell-muted" style="font-size:.78rem">\${esc((a.endpoint||'').replace(/^https?:[/][/]/,''))}</a></td>
      <td class="cell-muted">\${fmtDate(a.registered_at)}</td>
      <td style="text-align:left">\${fpTags || '<span class="cell-muted">—</span>'}</td>
    </tr>\`;
  }).join('');
}

function renderSubscribers(list) {
  const tbody = document.getElementById('subs-tbody');
  const countEl = document.getElementById('subs-count');
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td class="empty-note" colspan="4">No subscribers on record.</td></tr>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = list.filter(s=>s.active).length + ' active';
  tbody.innerHTML = list.map(s => \`<tr>
    <td class="cell-primary">\${esc(maskEmail(s.email))}</td>
    <td><span class="badge badge-pro">\${esc(s.tier || 'pro')}</span></td>
    <td class="cell-muted">\${fmtDate(s.created_at)}</td>
    <td><span class="badge \${s.active ? 'badge-active' : 'badge-inactive'}">\${s.active ? 'Active' : 'Lapsed'}</span></td>
  </tr>\`).join('');
}

function renderRateLimits(list) {
  const tbody = document.getElementById('rate-tbody');
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td class="empty-note" colspan="4">No queries recorded today.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map((entry, i) => {
    const capped = entry.count >= 10;
    return \`<tr>
      <td class="cell-muted">\${i + 1}</td>
      <td><span class="cell-mono">\${esc(entry.ip)}</span></td>
      <td class="\${entry.count >= 8 ? 'badge-capped' : 'cell-primary'}" style="font-variant-numeric:tabular-nums">\${entry.count} / 10</td>
      <td><span class="badge \${capped ? 'badge-capped' : 'badge-ok'}">\${capped ? 'Capped' : 'Within limit'}</span></td>
    </tr>\`;
  }).join('');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadStats() {
  clearError();
  const secret = getSecret();
  if (!secret) return;

  try {
    const res = await fetch('/admin/stats', {
      headers: { 'x-admin-secret': secret }
    });

    if (res.status === 401 || res.status === 403) {
      sessionStorage.removeItem(STORAGE_KEY);
      setLoginError('Wrong secret — try again.');
      document.getElementById('dashboard').style.display = 'none';
      document.getElementById('login-screen').style.display = 'flex';
      return;
    }

    if (!res.ok) {
      showError('Server error: ' + res.status);
      return;
    }

    const data = await res.json();

    // Show dashboard, hide login
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';

    // Stat cards
    document.getElementById('s-agents').textContent = data.agents?.total ?? '—';
    document.getElementById('s-subscribers').textContent = data.subscribers?.active ?? '—';
    document.getElementById('s-queries').textContent = data.queries?.today ?? '—';
    document.getElementById('s-ips').textContent = data.queries?.ips_active_today ?? '—';

    // Tables
    renderAgents(data.agents?.list || []);
    renderSubscribers(data.subscribers?.list || []);
    renderRateLimits(data.rate_limits?.top_ips || []);

    // Timestamp
    const now = new Date();
    document.getElementById('last-updated').textContent =
      'last updated ' + now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    // Schedule next refresh
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(loadStats, 30000);

  } catch (e) {
    showError('Network error: ' + e.message);
  }
}

// Auto-fetch if secret already in sessionStorage
const saved = getSecret();
if (saved) loadStats();

}); // end DOMContentLoaded
</script>
</body>
</html>`;

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const apiKey = req.headers['authorization']?.replace('Bearer ', '') || url.searchParams.get('api_key');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-admin-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── GET /health — unauthenticated liveness/readiness ──────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const db = loadDB();
      const keys = loadKeys();
      const active = Object.values(keys.keys || {}).filter(k => k.active).length;
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        agents: Object.keys(db.agents || {}).length,
        subscribers: active,
        uptime_seconds: Math.floor(process.uptime()),
        stripe: stripe ? 'live' : 'off',
        supabase_backup: sbEnabled() ? 'on' : 'off',
      }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── HTML pages ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200); res.end(LANDING_HTML); return;
  }
  if (req.method === 'GET' && url.pathname === '/pricing') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200); res.end(PRICING_HTML); return;
  }
  if (req.method === 'GET' && url.pathname === '/welcome') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200); res.end(WELCOME_HTML); return;
  }

  res.setHeader('Content-Type', 'application/json');

  // ── POST /register ─────────────────────────────────────────────────────────
  // Two paths:
  //   (a) { well_known_url } — index crawls it, binds owner-domain, verified:true
  //   (b) legacy inline { address, fingerprint, ... } — stored verified:false
  if (req.method === 'POST' && url.pathname === '/register') {
    const reg = checkActionLimit(ip, 'register');
    if (!reg.allowed) { res.writeHead(429); res.end(JSON.stringify({ error: reg.error })); return; }
    const { parsed: body } = await parseBody(req);

    // (a) Verified path — spec-compliant
    if (body.well_known_url) {
      const { doc, host, error, status } = await crawlWellKnown(body.well_known_url);
      if (error) { res.writeHead(status === 404 ? 404 : 502); res.end(JSON.stringify({ error })); return; }
      if (!doc.address || !doc.fingerprint || !doc.endpoint) {
        res.writeHead(422); res.end(JSON.stringify({ error: 'agent.json must declare address, endpoint, fingerprint' })); return;
      }
      if (body.address && body.address !== doc.address) {
        res.writeHead(409); res.end(JSON.stringify({ error: `address mismatch: requested ${body.address} but agent.json declares ${doc.address}` })); return;
      }
      const ownerLabel = ownerLabelFromAddress(doc.address);
      if (!ownerLabel) { res.writeHead(400); res.end(JSON.stringify({ error: 'malformed address in agent.json (expected id@owner.olw)' })); return; }
      if (!hostBindsToOwner(host, ownerLabel)) {
        res.writeHead(403); res.end(JSON.stringify({ error: `ownership not proven: ${host} is not bound to owner "${ownerLabel}" of ${doc.address}` })); return;
      }
      const db = loadDB();
      db.agents[doc.address] = {
        address: doc.address, name: doc.name, description: doc.description,
        endpoint: doc.endpoint, fingerprint: doc.fingerprint,
        verified: true, well_known_url: body.well_known_url,
        registered_at: new Date().toISOString(), verified_at: new Date().toISOString(), last_seen: new Date().toISOString(),
      };
      saveDB(db);
      res.writeHead(200);
      res.end(JSON.stringify({ registered: true, verified: true, address: doc.address, resolve_url: `${DOMAIN}/resolve?address=${encodeURIComponent(doc.address)}` }));
      return;
    }

    // (b) Legacy inline path — unverified, kept for SDK <= v1.0.3
    if (!body.address || !body.fingerprint) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'address and fingerprint required (or pass well_known_url for verified registration)' })); return;
    }
    const db = loadDB();
    db.agents[body.address] = { ...body, verified: false, registered_at: new Date().toISOString(), last_seen: new Date().toISOString() };
    saveDB(db);
    res.writeHead(200);
    res.end(JSON.stringify({ registered: true, verified: false, address: body.address, resolve_url: `${DOMAIN}/resolve?address=${encodeURIComponent(body.address)}` }));
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
      res.end(JSON.stringify({ error: rate.error, upgrade: `${DOMAIN}/pricing` }));
      return;
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const db = loadDB();
    const matches = Object.values(db.agents).filter(a => matchFingerprint(a.fingerprint, query));
    res.writeHead(200);
    res.end(JSON.stringify({ query, count: matches.length, agents: matches, tier: rate.tier, ...(rate.remaining !== undefined && { free_remaining: rate.remaining }) }));
    return;
  }

  // ── GET /agents ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/agents') {
    const db = loadDB();
    res.writeHead(200);
    res.end(JSON.stringify({ count: Object.keys(db.agents).length, agents: Object.values(db.agents) }));
    return;
  }

  // ── POST /checkout ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/checkout') {
    if (!stripe) { res.writeHead(503); res.end(JSON.stringify({ error: 'Stripe not configured' })); return; }
    if (!STRIPE_PRICE_ID) { res.writeHead(503); res.end(JSON.stringify({ error: 'Price not configured' })); return; }
    const col = checkActionLimit(ip, 'checkout');
    if (!col.allowed) { res.writeHead(429); res.end(JSON.stringify({ error: col.error })); return; }
    const { parsed: body } = await parseBody(req);
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
        metadata: { email: body.email || '', source: 'olw-index' },
        success_url: `${DOMAIN}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${DOMAIN}/pricing`,
        ...(body.email && { customer_email: body.email }),
        subscription_data: { metadata: { source: 'olw-index' } },
      });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, checkout_url: session.url, session_id: session.id }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /key — retrieve API key by session_id after payment ───────────────
  if (req.method === 'GET' && url.pathname === '/key') {
    const sessionId = url.searchParams.get('session_id');
    if (!sessionId) { res.writeHead(400); res.end(JSON.stringify({ error: 'session_id required' })); return; }
    const keys = loadKeys();
    const entry = keys.by_session?.[sessionId];
    if (!entry) {
      // Key not yet issued — webhook may be in-flight, tell client to retry
      res.writeHead(202); res.end(JSON.stringify({ status: 'pending', message: 'Key being activated, retry in 2s' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ api_key: entry.api_key, tier: 'pro', email: entry.email }));
    return;
  }

  // ── POST /webhook — Stripe events ─────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const { raw } = await parseBody(req);
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = STRIPE_WEBHOOK_SECRET
        ? stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET)
        : JSON.parse(raw.toString());
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Webhook signature invalid: ' + e.message })); return;
    }

    // Idempotency — Stripe may redeliver. Process each event.id exactly once.
    {
      const keys = loadKeys();
      if (!keys.processed_events) keys.processed_events = {};
      if (event.id && keys.processed_events[event.id]) {
        res.writeHead(200); res.end(JSON.stringify({ received: true, duplicate: true })); return;
      }
      if (event.id) { keys.processed_events[event.id] = new Date().toISOString(); saveKeys(keys); }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.email || '';
      const newKey = generateApiKey();
      const keys = loadKeys();
      if (!keys.by_session) keys.by_session = {};
      const record = { api_key: newKey, active: true, email, tier: 'pro', created_at: new Date().toISOString(), stripe_session: session.id, stripe_customer: session.customer };
      keys.keys[newKey] = record;
      keys.by_session[session.id] = record;
      saveKeys(keys);
      sbMirrorKey(record); // best-effort durable backup
      console.log(`[OLW] Pro key issued for ${email || 'unknown'}: ${newKey.slice(0, 20)}...`);
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const keys = loadKeys();
      Object.values(keys.keys).forEach(v => {
        if (v.stripe_customer === sub.customer) v.active = false;
      });
      saveKeys(keys);
      sbMarkInactiveByCustomer(sub.customer); // mirror revocation
      console.log(`[OLW] Subscription cancelled: ${sub.customer}`);
    }

    if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      console.log(`[OLW] Payment failed for customer ${inv.customer} — subscription may lapse`);
    }

    res.writeHead(200); res.end(JSON.stringify({ received: true }));
    return;
  }

  // ── GET /verify ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/verify') {
    const key = apiKey;
    if (!key) { res.writeHead(400); res.end(JSON.stringify({ error: 'api_key required (Authorization: Bearer <key> or ?api_key=)' })); return; }
    const keys = loadKeys();
    const record = keys.keys[key];
    if (!record) { res.writeHead(404); res.end(JSON.stringify({ valid: false })); return; }
    res.writeHead(200);
    res.end(JSON.stringify({ valid: record.active, tier: record.tier, email: record.email }));
    return;
  }

  // ── GET /pricing (JSON fallback) ───────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/pricing.json') {
    res.writeHead(200);
    res.end(JSON.stringify({
      free: { queries_per_day: 10, registrations: 1, price: '$0' },
      pro: { queries_per_day: 'unlimited', registrations: 100, price: '$29/mo', checkout: `${DOMAIN}/pricing` },
      enterprise: { queries_per_day: 'unlimited', registrations: 'unlimited', private_index: true, sla: true, price: 'contact', email: 'martings1@charleston.edu' },
    }));
    return;
  }

  // ── GET /admin — dashboard UI ──────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/admin') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(ADMIN_HTML);
    return;
  }

  // ── GET /admin/stats — protected stats API ─────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/admin/stats') {
    if (!checkAdminAuth(req, url)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized — x-admin-secret required' }));
      return;
    }

    const db = loadDB();
    const keys = loadKeys();
    const rateData = loadRate();
    const today = new Date().toISOString().slice(0, 10);

    // Agents
    const agentList = Object.values(db.agents);

    // Subscribers — strip raw api_key from list, keep metadata
    const subList = Object.values(keys.keys).map(k => ({
      email: k.email || '',
      tier: k.tier || 'pro',
      created_at: k.created_at || '',
      active: !!k.active,
    }));
    const activeCount = subList.filter(s => s.active).length;

    // Queries today across all IPs
    let queriesToday = 0;
    let ipsActiveToday = 0;
    const ipEntries = [];
    for (const [ip, days] of Object.entries(rateData.ips || {})) {
      const count = days[today] || 0;
      if (count > 0) {
        queriesToday += count;
        ipsActiveToday++;
        ipEntries.push({ ip, count });
      }
    }
    ipEntries.sort((a, b) => b.count - a.count);
    const topIPs = ipEntries.slice(0, 10);

    res.writeHead(200);
    res.end(JSON.stringify({
      agents: { total: agentList.length, list: agentList },
      subscribers: { total: subList.length, active: activeCount, list: subList },
      queries: { today: queriesToday, ips_active_today: ipsActiveToday },
      rate_limits: { top_ips: topIPs },
      server: { uptime_seconds: Math.floor(process.uptime()), domain: DOMAIN },
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ routes: ['GET /health','POST /register','GET /resolve','GET /query','GET /agents','POST /checkout','GET /key','POST /webhook','GET /pricing','GET /welcome','GET /verify','GET /admin','GET /admin/stats'] }));
});

server.listen(PORT, () => {
  console.log(`OLW Resolution Index :${PORT}`);
  console.log(`Stripe: ${stripe ? 'live' : 'not configured'} | Price: ${STRIPE_PRICE_ID || 'not set'} | Webhook: ${STRIPE_WEBHOOK_SECRET ? 'verified' : 'unverified'}`);
  console.log(`Supabase backup: ${sbEnabled() ? 'on' : 'off'}`);
  console.log(`Domain: ${DOMAIN}`);
  sbReconcileOnBoot(); // restore keys from backup if local file is empty
});
