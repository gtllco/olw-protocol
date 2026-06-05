# OLW — Architecture

**Mapped:** 2026-06-05

## What OLW is
The **routing layer for the agent internet**. Agents get an address
`{agent-id}@{owner-domain}.olw` and publish a capability fingerprint. Any agent
can discover/resolve any other via the central resolution index OR by crawling
`https://{domain}/.well-known/olw/agent.json`. Fills the gap A2A leaves open
("does not prescribe a standard API").

## Resolution model (3 paths)
1. Central index: `GET olw.gtll.app/resolve?address=…`
2. Decentralized: crawl `/.well-known/olw/agent.json` on the owner domain
3. Local cache

## 8-axis capability fingerprint
`domain · task_types[] · input_formats[] · output_formats[] · context_depth ·
latency_class · trust_level · soul_compatible`
→ matched by `matchFingerprint()` (arrays=intersection, bool=eq, scalar=string eq)

## Index server routes (`index-server/index.js`)
| Route | Purpose | Auth |
|-------|---------|------|
| `POST /register` | register agent + fingerprint | none |
| `GET /resolve?address=` | resolve one address → full record | none |
| `GET /query?<fp axes>` | search by fingerprint | rate-limited (free) / Bearer (pro) |
| `GET /agents` | list all | none |
| `POST /checkout` | create Stripe Checkout Session | none |
| `POST /webhook` | Stripe events → issue/revoke keys | Stripe signature |
| `GET /key?session_id=` | retrieve issued key post-payment | session id |
| `GET /verify?api_key=` | validate a key | none |
| `GET /pricing.json` | tier definitions | none |
| `GET /` `/pricing` `/welcome` `/admin` | HTML pages | (admin gated client-side + stats API) |
| `GET /admin/stats` | dashboard data | `x-admin-secret` |

## Tiers / rate limiting
- **Free:** 10 queries/day per IP, 1 registration. Counted in `rate-limits.json`.
- **Pro ($29/mo):** unlimited queries via Bearer key. `checkRateLimit` short-circuits when a valid active key is present.
- **Enterprise:** contact.

## Payment → key issuance flow
```
/checkout → Stripe Checkout (cs_live_…) → user pays →
Stripe POSTs signed checkout.session.completed → /webhook verifies sig →
generateApiKey() (olw_live_<48 hex>) → stored in keys[] + by_session[] →
/welcome polls /key?session_id → key delivered → /verify confirms
```
Revocation: `customer.subscription.deleted` → mark key `active:false`.
