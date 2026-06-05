# OLW — State

**Updated:** 2026-06-05

## Position
Phase 1 (Launch) + Phase 2 (Harden & Trust) + Phase 3 (Decentralized Resolution) **COMPLETE**.

## Phase 3 shipped (2026-06-05)
- `.well-known/olw/agent.json` confirmed live at `https://777.gtll.app/.well-known/olw/agent.json` (soul-guide@gtll.olw)
- SDK v1.1.0: `resolve()` falls back to `.well-known` crawl when index returns 404 or is unreachable
- Added `_well_known_url_for()` — derives crawl URL from OLW address using `OLW_DOMAIN_MAP`
- Added `_crawl_well_known()` — fetches, validates, and address-verifies agent.json; graceful DNS failure handling
- `OLW_DOMAIN_MAP`: `gtll → 777.gtll.app`, `777 → 777.gtll.app` (extensible)
- Added `PUBLIC_INDEX = "https://olw.gtll.app"` constant
- `docs/publisher-guide.md`: full publisher guide with schema, nginx config, registration, and decentralized resolution
- Synced to both `sdk/python/` and `olw-py/` source trees
- 33/33 Playwright tests green after changes
- Committed: `4faaa28 feat(phase-3): decentralized .well-known resolution + publisher guide`

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
- PyPI: `olw-protocol` v1.0.3 (`import olw`) — v1.1.0 pending PyPI publish
- Repo: gtllco/olw-protocol (main @ pushed to Phase 3 commit)

## Verified this session (2026-06-05 Phase 3)
- 33/33 Playwright tests green (api + ui)
- 6/6 Python SDK unit tests green (URL derivation, crawl, index resolve, fallback, both-miss, no-fallback)
- `soul-guide@gtll.olw` resolves via: (a) index at localhost:3778, (b) .well-known crawl at 777.gtll.app
- address mismatch detection works (ValueError on wrong address in agent.json)
- DNS failure for unknown .olw domains returns None gracefully (no exception propagation)

## Current data
- Registered agents: 1 (`soul-guide@gtll.olw`)
- Pro subscribers: 0
- No api-keys.json (no real purchases yet)

## Next (Phase 4 — Multi-Agent Mesh)
- Peer-to-peer agent discovery without index or well-known (gossip/DHT layer)
- Agent-to-agent message passing via the A2A endpoint spec
- Publish SDK v1.1.0 to PyPI
- Add OLW_DOMAIN_MAP entries as new agents deploy
