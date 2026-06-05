# Phase 2 — Harden & Trust · PLAN

**Status:** Ready to execute
**Created:** 2026-06-05

## Goal (what must be TRUE)
1. An address can only be registered by whoever controls the domain that serves
   its `.well-known/olw/agent.json`. (No more hijacking `soul-guide@gtll.olw`.)
2. Paying customers' API keys survive loss of the server's disk.
3. `/register` and `/checkout` can't be spammed to exhaust the index or Stripe.
4. A replayed Stripe webhook does not issue duplicate keys.
5. There is a machine-checkable signal that the index is up.

## Context discovered
- **The spec already says `/register` is crawl-based** (`POST { well_known_url }`),
  but `index.js` takes the full agent record inline with no verification. This phase
  makes the code match the spec — it's not new surface area.
- `.well-known/olw/agent.json` is live (200) at `https://777.gtll.app/...` and
  declares `address: soul-guide@gtll.olw`. Real fixture to test against.
- Supabase is reachable from the box (`sb.gtll.app`, anon key in secrets). Use a
  `olw_api_keys` table for backup mirror.

---

## Tasks (atomic commits)

### 2-01 · Ownership-verified registration
**Make `/register` crawl `.well-known` and prove ownership.**
- Accept `{ well_known_url }` (new, spec-compliant) OR legacy inline body behind a flag.
- Fetch `well_known_url` (timeout 5s, https only, no redirects to other hosts).
- Parse `agent.json`; require `address`, `endpoint`, `fingerprint`.
- **Binding rule:** the address's owner-domain must map to the well_known host.
  `agent-id@{owner}.olw` → host must be `{owner}` resolved to a real domain
  (`gtll.olw` → `gtll.app`, or host endswith the owner label). Reject mismatches
  with 403 + clear message.
- Require `agent.json.address === requested address` (if address also passed).
- On success store record with `verified: true`, `well_known_url`, `verified_at`.
- **Verify:** registering `soul-guide@gtll.olw` from `https://777.gtll.app/.well-known/olw/agent.json` succeeds; the same address from a `well_known_url` on an unrelated host returns 403; missing file → 502/404.

### 2-02 · Rate-limit /register and /checkout
**Reuse IP tracking; cap abuse.**
- `/register`: max 10/day per IP (registrations are rare and verified).
- `/checkout`: max 20/hour per IP (prevents Stripe session spam).
- Return 429 with retry hint. Track in `rate-limits.json` under separate buckets.
- **Verify:** 11th register / 21st checkout from one IP within window → 429; legitimate single calls unaffected.

### 2-03 · Webhook idempotency
**Dedupe by Stripe `event.id`.**
- Persist processed event ids in `api-keys.json` (`processed_events: { id: ts }`).
- On `/webhook`, if `event.id` already processed → 200 `{ received: true, duplicate: true }`, no new key.
- **Verify:** firing the same signed `checkout.session.completed` twice issues exactly one key (extend `tests/e2e-payment.mjs`).

### 2-04 · API-key backup to Supabase
**Mirror key issuance/revocation to a durable store.**
- On key issue/revoke, upsert to Supabase `olw_api_keys`
  (`api_key, email, tier, active, stripe_customer, created_at`).
- Best-effort, non-blocking: a Supabase failure must NOT fail the webhook
  (log + continue). Local JSON stays source of truth; Supabase is the backup.
- Add a `loadKeys` reconcile-on-boot: if local file missing but Supabase has rows, restore.
- **Verify:** issue a key via e2e test → row appears in Supabase; delete local file, restart → keys restored.

### 2-05 · Health endpoint + monitor
- `GET /health` → `{ ok: true, agents, subscribers, uptime_seconds, stripe: 'live'|'off' }` (no secret).
- Add a tiny systemd timer OR document a cron curl that alerts via `/soulProxy` if `/health` ≠ 200.
- **Verify:** `curl olw.gtll.app/health` → 200 JSON; kill service → monitor fires (manual check ok).

---

## Out of scope (backlog)
- SQLite/Supabase as *primary* store (this phase only mirrors keys for backup).
- Dropping `?admin_secret=` query fallback (separate small task).
- JS/TS SDK (Phase 4).

## Done when
All 5 tasks committed atomically, `tests/e2e-payment.mjs` extended for idempotency,
a new `tests/register-ownership.mjs` proves the verification rules, full suite green,
STATE.md updated, pushed to GitHub.
