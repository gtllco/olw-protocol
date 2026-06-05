# OLW — Concerns / Risks

**Mapped:** 2026-06-05

## Data durability
- **Flat JSON files**, no DB, no locking. Concurrent writes (e.g. simultaneous
  `/register` + `/query` rate increment) can race and clobber. Fine at current
  volume; revisit before real traffic. Candidate: SQLite or Supabase.
- No backups of `api-keys.json` — losing it = losing all paying subscribers' keys.
  **Should back up to Supabase or disk snapshot.**

## Security
- `/register` is **unauthenticated** — anyone can register/overwrite any address,
  including overwriting `soul-guide@gtll.olw`. No ownership proof. Spec mentions
  `.well-known` verification but it's not enforced server-side.
- Admin secret passed as query param option (`?admin_secret=`) → can leak via logs.
  Header path is safe; consider dropping the query fallback.
- No rate limit on `/register` or `/checkout` → abuse / Stripe session spam.

## Payments
- ✅ Webhook signature verified (fixed). ✅ E2E flow green.
- Key delivery depends on webhook firing before user polls — handled with 202 retry.
- No idempotency: a replayed `checkout.session.completed` issues a *second* key for
  the same session (overwrites `by_session` but leaves orphan in `keys`). Low risk.

## Ops
- Single bare process; `Restart=always` covers crashes. No health check beyond `/agents`.
- `.well-known/olw/` lives at `/opt/777/.well-known/olw` — decentralized resolution
  path depends on that being served. Verify it's wired to a domain.

## Tests
- ✅ 33 Playwright + 15 e2e payment assertions passing.
- No CI — tests run manually. Consider a systemd timer or git hook.
- `tests/debug.spec.js` is a diagnostic, not a real assertion — keep or delete.
