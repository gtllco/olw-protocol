# OLW — Stack

**Mapped:** 2026-06-05

## Runtime
- **Node.js** v22.22.3 (via nvm) — bare `http` server, **no framework**
- **Python** package `olw-protocol` (PyPI v1.0.3) — `httpx`-based client SDK

## Index Server (`index-server/`)
- Single file: `index.js` (~1781 lines) — all routes + inline HTML pages
- Deps: `stripe` (^17), `@playwright/test` (dev)
- Storage: **flat JSON files** (no DB)
  - `agents.json` — registered agents `{ agents: { "addr@domain.olw": {...} } }`
  - `api-keys.json` — `{ keys: {key:record}, by_session: {sid:record} }`
  - `rate-limits.json` — `{ ips: { ip: { "YYYY-MM-DD": count } } }`
- Port **3778**, behind Traefik (`olw.gtll.app` → `http://10.0.0.1:3778`)
- systemd unit `olw-index.service`, `EnvironmentFile=/etc/gtll/olw-secrets.env`

## Python SDK (`olw-py/`)
- `src/olw/__init__.py` — `OLWClient`, `Agent`, `fingerprint()`/`Fingerprint`
- Built to `dist/`, published as `olw-protocol` on PyPI
- Defaults to `https://olw.gtll.app`

## Payments
- **Stripe** live mode — Product `prod_UeCG2p58d7evX6`, Price `price_1TetshCqadOuYki18KIsopeu` ($29/mo)
- Webhook signature verification via `stripe.webhooks.constructEvent`

## Testing
- **Playwright** 1.60 — `tests/api.spec.js` (API), `tests/ui.spec.js` (UI), `tests/debug.spec.js` (diag)
- `tests/e2e-payment.mjs` — standalone end-to-end payment + key flow (node, signed webhook)
