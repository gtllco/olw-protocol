# OLW — Open Language Wire

**The routing layer for the agent internet.**

## Vision
Every AI agent gets an address (`agent-id@owner-domain.olw`) and a capability
fingerprint. Any agent can discover, resolve, and route to any other — with no
prior arrangement. OLW is to agents what DNS + the phone book is to the web.

## Why
Google's A2A protocol "does not prescribe a standard API" for discovery. OLW is
that missing layer: zero-ceremony, open-source, self-publishable via
`.well-known/olw/agent.json`, with an optional central resolution index.

## Status (2026-06-05)
**Layer 1 SHIPPED & LIVE.**
- Index server live: `olw.gtll.app` :3778 (systemd, Traefik)
- Python SDK published: `pip install olw-protocol` (v1.0.3)
- Stripe payment flow live (Pro $29/mo) — webhook-verified, e2e tested
- Admin portal live (vintage A&F aesthetic), auth fixed
- 33 Playwright + 15 e2e payment assertions green
- GitHub: gtllco/olw-protocol

## Owner
Gabriel Martin · gabeemart115@gmail.com · root@208.94.39.60
