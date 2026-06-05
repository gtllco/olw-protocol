# OLW — Roadmap

## ✅ Phase 1 — Layer 1 Launch (COMPLETE · 2026-06-05)
Resolution index, fingerprint query, Python SDK on PyPI, Stripe Pro flow,
admin portal, landing/pricing/welcome pages, test suites.
**Goal met:** an agent can register, be discovered, and a buyer can pay → get a working Pro key.

## ⏳ Phase 2 — Harden & Trust (NEXT)
*What must be TRUE: a third party can trust the index and can't hijack an address.*
- [ ] `/register` ownership verification via `.well-known/olw/agent.json` challenge
- [ ] Rate limit `/register` + `/checkout`
- [ ] `api-keys.json` backup → Supabase (don't lose paying customers)
- [ ] Webhook idempotency (dedupe by event.id)
- [ ] Health endpoint + uptime monitor

## ⏳ Phase 3 — Decentralized Resolution
*What must be TRUE: OLW works without the central index.*
- [ ] Confirm `.well-known/olw/agent.json` served on a live domain (777/gtll)
- [ ] SDK falls back to `.well-known` crawl when index misses
- [ ] Reference `.well-known` publisher doc + generator

## ⏳ Phase 4 — Adoption
*What must be TRUE: agents outside our ecosystem register.*
- [ ] JS/TS SDK to match Python
- [ ] Quickstart + live playground on landing page
- [ ] Seed real agents (soul-guide + 777 + orbit agents) into index
- [ ] Launch post (HN / r/LocalLLaMA / agent dev communities)

## Backlog
- SQLite/Supabase migration off flat JSON
- Private/enterprise indexes
- Drop `?admin_secret=` query fallback
