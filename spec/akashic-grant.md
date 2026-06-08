# AkashicGrant — Spec v1.0

The consent primitive of the Akashic Layer. No agent reads another agent's field state
without a valid, signed, non-expired, non-revoked AkashicGrant.

## Definition

```python
class AkashicGrant:
    id:          str              # server-assigned: "grant_<32 hex chars>"
    grantor:     OLWAddress       # Who is sharing
    grantee:     OLWAddress       # Who receives access
    fields:      list[str]        # Field path patterns: exact paths or wildcards ("*", "session.*")
    permissions: list[Permission] # Subset of ["read", "write", "subscribe"]
    expires_at:  datetime         # Mandatory. No perpetual grants.
    conditions:  dict | None      # Optional: { "ip_allowlist": [...], "time_of_day": {...} }
    signature:   str              # Ed25519(canonical_grant_json, grantor_ed25519_priv)
    created_at:  datetime
    revoked:     bool
    revoked_at:  datetime | None

class Permission(Enum):
    READ      = "read"        # Grantee can pull field ciphertext
    WRITE     = "write"       # Grantee can update field state in grantor's namespace
    SUBSCRIBE = "subscribe"   # Grantee receives events when fields change (future)
```

## Canonical Signature Payload

Grant signature is over a deterministic JSON encoding — sorted keys, no whitespace:

```
canonical = JSON.stringify({
  grantor:    <str>,
  grantee:    <str>,
  fields:     <array>,
  permissions:<array>,
  expires_at: <str>,
  conditions: <obj>   // omit if null
})

signature = Ed25519.sign(Buffer.from(canonical), grantor_ed25519_priv)
```

The server verifies this signature against the grantor's registered `ed25519_pub` before storing.

## Field Path Patterns

Grants support three pattern types:

| Pattern | Matches |
|---------|---------|
| `"*"` | All field paths in namespace |
| `"session.*"` | All paths under `session.` prefix |
| `"session.context.summary"` | Exactly that path |

## Rules

1. **`expires_at` is mandatory.** No perpetual grants. Max recommended: 90 days.
2. **Permissions are minimum-necessary.** Never grant `write` when `read` is sufficient.
3. **Revocation is instant.** Server checks revoked flag on every read/write.
4. **Only the grantor can revoke.** Revocation requires Ed25519 signature over `grant_id`.
5. **Grants are per-agent, not per-domain.** A grant to `agent-a@acme.olw` does not apply to `agent-b@acme.olw`.

## API

### Create grant
```
POST /akashic/grant
{
  "grant": {
    "grantor":     "owner@acme.olw",
    "grantee":     "reader@partner.olw",
    "fields":      ["session.*", "trip.status"],
    "permissions": ["read"],
    "expires_at":  "2026-09-01T00:00:00Z"
  },
  "signature": "<base64url Ed25519 of canonical grant json>"
}
```

Response:
```json
{
  "ok": true,
  "grant_id": "grant_a3f9...",
  "grant": { ... }
}
```

### Revoke grant
```
DELETE /akashic/grant
{
  "grant_id":            "grant_a3f9...",
  "revoker_address":     "owner@acme.olw",
  "revocation_signature": "<base64url Ed25519 of grant_id string>"
}
```

## Grant Lifecycle

```
[created] → [active] → [expired]  (natural expiry)
                ↘ [revoked]        (owner-triggered, instant)
```

Expired and revoked grants are kept for audit purposes but never used for access control.

## Relationship to HIPAA Minimum Necessary

Each grant specifies **exact field paths** — never the full namespace.
This mirrors HIPAA §164.502(b): agents receive only the specific data necessary for the task,
not broader access.

## Signing Example (Node.js)

```js
import crypto from 'crypto';

const grantBody = {
  grantor: 'owner@acme.olw',
  grantee: 'reader@partner.olw',
  fields: ['session.*'],
  permissions: ['read'],
  expires_at: '2026-09-01T00:00:00Z',
};

const canonical = JSON.stringify(
  Object.fromEntries(['grantor','grantee','fields','permissions','expires_at']
    .filter(k => grantBody[k] !== undefined)
    .map(k => [k, grantBody[k]]))
);

const privKey = crypto.createPrivateKey({
  key: Buffer.from(grantor_ed25519_priv_b64url, 'base64url'),
  format: 'der', type: 'pkcs8',
});

const signature = crypto.sign(null, Buffer.from(canonical), privKey).toString('base64url');
```
