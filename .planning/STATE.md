# OLW — State

**Updated:** 2026-06-05

## Position
Phase 1 (Launch) + Phase 2 (Harden & Trust) + Phase 3 (Decentralized Resolution) **COMPLETE**.
**555 PULL ENGINE SHIPPED (2026-06-05 PM).**

## 555 Pull shipped (2026-06-05)
- `POST /pull` — semantic capability discovery. `{intent, constraints?, k?}` → hard-gate on 8-axis fingerprint → embed intent → cosine rank → reasoned "why" in axis vocabulary (NOT a bare score — Soul Guide's hinge).
- Embeddings sovereign: local `nomic-embed-text` on ollama (768d), $0/query, vectors never leave box. Code: `/opt/olw/index-server/pull.js`.
- Embed-on-register hook (both register paths) via `embedAgent()`; `pub()` strips `_vec` from all public outputs (/resolve, /query, /agents) — shapes unchanged.
- Backfill: `reindex.mjs`. Seed: `seed-agents.mjs` (6 REAL agents — 5 GTLL product agents @ real conversations endpoint + orbit-router; honest fingerprints, no sims).
- Index now 8 agents, all embedded. Live verified: payment-chaser/trip-planner/orbit-router/venue-coordinator each rank #1 for matching NL intent; `soul_compatible:true` gate narrows 8→2. **33/33 Playwright tests green, no _vec leak.**
- Aesthetic PDF (`/opt/preview/OLW-555-The-Pull.pdf`) emailed to gabeemart115@gmail.com.
- NOTE: Gemini key on box is DEAD (API_KEY_INVALID); litellm Token Factory OUT OF BUDGET (402) — no external cross-model route live; Soul Guide (Anthropic) used as council.

## 777 mesh viz shipped (2026-06-05)
- `GET /mesh` — live pull visualization at https://olw.gtll.app/mesh (public 200). Canvas constellation of the real agents; type intent → matched nodes pull toward center ranked by score, glowing edges, reasoned "why" panel; non-matches dim. The API response IS the render (no seam — Soul Guide's condition 3 met). Served from `mesh.html` loaded at boot. Verified headless (puppeteer): payment-chaser #1 @0.68 for "collect money owed fast". Demo asset: `mesh-demo.png`.

## Next to land 777 (Soul Guide's three conditions)
- [x] orb/mesh render consumes `/pull` state directly (no seam) — DONE via /mesh
- [ ] add `pull()` to SDK (Python + ship JS/TS); freeze + publish the 8-axis schema as finished artifact; one-breath registration

## Phase 3 shipped (2026-06-05)
- `.well-known/olw/agent.json` live at `https://777.gtll.app/.well-known/olw/agent.json` (soul-guide@gtll.olw)
  - REGRESSION FIXED (2026-06-05 PM): 777.gtll.app was repointed to the `meridian` container, orphaning the file in `/opt/777` — public URL 404'd, decentralized resolution silently broken. Fixed by placing the file in meridian's Vite source `/opt/meridian/public/.well-known/olw/agent.json` (survives `vite build`) → now serving live + verified via SDK crawl + address-mismatch rejection. Canonical copy still at `/opt/777/.well-known/olw/agent.json`.
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
