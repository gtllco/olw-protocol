# AkashicField — Spec v1.0

The fundamental unit of shared state in the OLW Akashic Layer.

## Definition

```python
class AkashicField:
    namespace:   OLWAddress        # Owner's OLW address — controls who can write
    field_path:  str               # Hierarchical path: "session.context.summary"
    ciphertext:  str               # base64url sealed box — only grantees can decrypt
    version:     int               # Monotonically increasing per namespace+field_path
    writer:      OLWAddress        # OLW address of the writing agent
    signature:   str               # Ed25519(namespace|field_path|ciphertext|version)
    written_at:  datetime          # UTC ISO 8601
    propagation: PropagationType   # local | regional | global | directed
    ttl:         int | None        # Seconds until expiry. None = persistent.
    expires_at:  datetime | None   # Computed from written_at + ttl
```

## Wire Format — Sealed Box (ciphertext)

```
[ ephemeral_x25519_pub (32 bytes)
| AES-256-GCM nonce    (12 bytes)
| encrypted payload    (variable)
| GCM auth tag         (16 bytes) ]

All encoded as base64url.
```

Encryption:
1. Generate ephemeral X25519 keypair (sender anonymous)
2. ECDH(ephemeral_priv, recipient_x25519_pub) → shared_secret
3. HKDF-SHA256(shared_secret, info="OLW-AkashicField-v1", salt=ephemeral_pub||recipient_pub) → 32-byte key
4. AES-256-GCM encrypt with random 12-byte nonce
5. Concatenate → base64url

## field_path Rules

- Alphanumeric, dots (`.`), hyphens (`-`), underscores (`_`)
- Max 256 characters
- Hierarchical by convention: `domain.subdomain.leaf`
- Examples:
  - `session.context.summary`
  - `trip.status.confirmed`
  - `agent.memory.last_intent`

## PropagationType

| Value | Meaning |
|-------|---------|
| `local` | Stays on origin node — default, private |
| `regional` | Propagates within geographic region |
| `global` | Propagates to all federated nodes |
| `directed` | Propagates only to grantee-nearest nodes |

## Write Authorization

A field write requires ONE of:
1. `writer == namespace` (owner writes to their own namespace)
2. Valid non-expired non-revoked `AkashicGrant` where `grantor == namespace`, `grantee == writer`, `field_path` matches, `permissions` includes `"write"`

## Signature

```
payload = f"{namespace}|{field_path}|{ciphertext}|{version}"
signature = Ed25519.sign(payload.encode(), writer_ed25519_priv)
```

Verifier: index server checks signature against writer's registered `ed25519_pub`.

## API

```
POST /akashic/write
{
  "writer":      "agent@domain.olw",
  "namespace":   "owner@domain.olw",
  "field_path":  "session.context.summary",
  "ciphertext":  "<base64url sealed box>",
  "signature":   "<base64url Ed25519 sig>",
  "propagation": "local",
  "ttl":         3600
}
```

Response:
```json
{ "ok": true, "namespace": "...", "field_path": "...", "version": 2 }
```

## CRDT Conflict Resolution

Multiple writers may race on the same `namespace::field_path`. Resolution:
- **Simple values**: Last-Writer-Wins by `written_at` timestamp
- **Collections**: OR-Set CRDT (planned)
- **Documents**: Merkle-DAG with vector clock — implemented in `rsb/rsb.py` (`FieldCRDT`), integration into `akashic.js` in progress

Current default: LWW — highest `version` wins (monotonic per write path).
Merkle-DAG upgrade: `FieldCRDT.merge()` guarantees commutativity, associativity, and idempotency across concurrent writers with no coordinator required.
