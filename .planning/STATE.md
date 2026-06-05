# OLW — State

**Updated:** 2026-06-05

## Position
Phase 1 (Launch) + Phase 2 (Harden & Trust) **COMPLETE**. Next up: Phase 3 (Decentralized Resolution).

## Phase 2 shipped (2026-06-05)
- `/register` dual-path: `well_known_url` crawl + owner-domain binding (verified:true); legacy inline (verified:false). Owner label must appear as a dot-segment of the serving host.
- Rate limits: register 10/day, checkout 20/hr per remote IP (loopback exempt). Free `/query` cap 10/day also exempts loopback.
- Webhook idempotency via `processed_events[event.id]`.
- Supabase backup: table `public.olw_api_keys` (self-hosted, service_role). Mirror on issue/revoke, restore-on-boot if local file empty. Secrets: SUPABASE_URL + SUPABASE_SERVICE_KEY in olw-secrets.env.
- `/health` (public) + `/opt/olw/index-server/monitor.sh` cron (*/5) → /soulProxy on failure.
- Test fixture: `/opt/777/.well-known/olw/test-mismatch.json` (used by register-ownership.mjs — do not delete).
- Tests: register-ownership.mjs, e2e-payment.mjs (+idempotency), backup-restore.sh.

## Live infra
- Service: `olw-index.service` (systemd, active), node v22.22.3, port 3778
- Public: `https://olw.gtll.app` (Traefik → 10.0.0.1:3778, wildcard *.gtll.app cert)
- Secrets: `/etc/gtll/olw-secrets.env`
- Stripe: live · Product `prod_UeCG2p58d7evX6` · Price `price_1TetshCqadOuYki18KIsopeu` ($29/mo) · webhook verified
- PyPI: `olw-protocol` v1.0.3 (`import olw`)
- Repo: gtllco/olw-protocol (main @ pushed)

## Verified this session (2026-06-05)
- Admin login bug fixed (JS regex `\/\/` → `[/][/]` template-literal escape). Root cause: served HTML had `/^https?:///` → invalid JS → whole admin script failed to parse → no event listeners bound.
- 33/33 Playwright tests green (api + ui)
- 15/15 e2e payment assertions green (`tests/e2e-payment.mjs`): checkout → signed webhook (rejects bad sig, accepts good) → /key → /verify → Pro /query uncapped
- Cleaned test data from live `agents.json` + `api-keys.json`

## Current data
- Registered agents: 1 (`soul-guide@gtll.olw`)
- Pro subscribers: 0
- No api-keys.json (no real purchases yet)

## Open decisions
- Phase 2 first task: ownership verification on /register (security) vs keys backup (durability)?
