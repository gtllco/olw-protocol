# OLW — Open Language Wire

[![PyPI](https://img.shields.io/pypi/v/olw-protocol)](https://pypi.org/project/olw-protocol/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**The routing layer for the agent internet.**

Three elements. One protocol.

```bash
pip install olw-protocol
```

---

## Element 1 — Discovery

Every agent gets a permanent address. Any agent can find any other by capability.

```python
import olw

# Register your agent
my_agent = olw.Agent(
    address="analyst@acme.olw",
    name="Analyst",
    description="Summarizes financial documents.",
    endpoint="https://agents.acme.com/olw/analyst",
    fingerprint=olw.fingerprint(
        domain="finance",
        task_types=["summarize", "extract"],
        input_formats=["text", "pdf"],
        output_formats=["json"],
        context_depth="deep",
        latency_class="standard",
        trust_level="open",
    )
)
my_agent.register()  # https://olw.gtll.app

# Find agents by capability
agents = olw.query(domain="legal", trust_level="open")

# Resolve an address (index + .well-known fallback)
agent = olw.resolve("analyst@acme.olw")
```

Drop `/.well-known/olw/agent.json` on your domain and any agent on the internet can find you — index or not.

---

## Element 3 — Akashic Layer

Shared encrypted field state for sandboxed agents. Agents can write sealed fields and grant other agents consent-gated read access — over standard HTTP, no outbound calls required.

```python
import olw

# Generate a keypair for your agent
keys = olw.akashic_keygen()
olw.akashic_register_keys(
    address="my-agent@acme.olw",
    x25519_pub=keys["x25519_pub"],
    ed25519_pub=keys["ed25519_pub"],
)

# Write an encrypted field (sealed to recipient's public key)
olw.akashic_write(
    writer="my-agent@acme.olw",
    ed25519_priv=keys["ed25519_priv"],
    namespace="my-agent@acme.olw",
    field_path="session.context",
    value="trip confirmed: 4 nights, Charleston, 14 guests",
    recipient="my-agent@acme.olw",
)

# Grant another agent read access
olw.akashic_grant(
    grantor="my-agent@acme.olw",
    ed25519_priv=keys["ed25519_priv"],
    grantee="coordinator@acme.olw",
    fields=["session.*"],
    permissions=["read"],
    expires_at="2027-01-01T00:00:00Z",
)

# Read a field (decrypts automatically with your private key)
fields = olw.akashic_read(
    requester="coordinator@acme.olw",
    x25519_priv=coord_keys["x25519_priv"],
    namespace="my-agent@acme.olw",
    field_paths=["session.context"],
)
```

**Crypto primitives (Node.js native / standard libraries — no external crypto deps):**
- X25519 ECDH — sealed box sender ephemeral key
- Ed25519 — field write and grant signatures
- AES-256-GCM — authenticated encryption
- HKDF-SHA256 — key derivation

Full wire format: [`spec/akashic-field.md`](spec/akashic-field.md)

---

## The gap — stated explicitly in the A2A spec

> "The current A2A specification does not prescribe a standard API for curated registries."

A2A defines how agents *talk*. OLW defines how they *find each other* and *share state*. Google, IBM, Salesforce are all A2A members. None of them shipped cold-start resolution or shared field state. That's the gap. That's the moat.

---

## REST API

Public index: `https://olw.gtll.app`

```bash
# Register
curl -X POST https://olw.gtll.app/register \
  -H "Content-Type: application/json" \
  -d '{"well_known_url": "https://acme.com/.well-known/olw/agent.json"}'

# Query
curl "https://olw.gtll.app/query?domain=finance&trust_level=open"

# Resolve
curl "https://olw.gtll.app/resolve?address=analyst@acme.olw"

# Akashic — generate keypair
curl -X POST https://olw.gtll.app/akashic/keygen

# Akashic — write a field
curl -X POST https://olw.gtll.app/akashic/write \
  -H "Content-Type: application/json" \
  -d '{"writer":"agent@acme.olw","namespace":"agent@acme.olw","field_path":"session.ctx","ciphertext":"<sealed_box>","signature":"<ed25519_sig>"}'

# Akashic — stats
curl https://olw.gtll.app/akashic/stats
```

Full Akashic API (12 endpoints): `POST /akashic/keygen` · `POST /akashic/keys` · `GET /akashic/keys` · `POST /akashic/write` · `POST /akashic/read` · `POST /akashic/grant` · `DELETE /akashic/grant` · `DELETE /akashic/erase` · `GET /akashic/audit` · `GET /akashic/stats` · `POST /akashic/seal` · `POST /akashic/open`

---

## MCP Adapter (Claude / any MCP-compatible host)

```bash
# Install and configure
cp adapters/claude-mcp/config.json.example adapters/claude-mcp/config.json
# Fill in your OLW address and private keys
node adapters/claude-mcp/server.js
```

Add to `.claude/mcp.json`:
```json
{
  "mcpServers": {
    "olw-akashic": {
      "command": "node",
      "args": ["/path/to/adapters/claude-mcp/server.js"],
      "env": {
        "OLW_ADDRESS": "my-agent@acme.olw",
        "OLW_INDEX_URL": "https://olw.gtll.app",
        "OLW_X25519_PRIV": "<your_x25519_priv>",
        "OLW_ED25519_PRIV": "<your_ed25519_priv>"
      }
    }
  }
}
```

8 tools: `akashic_keygen` · `akashic_register_keys` · `akashic_write` · `akashic_read` · `akashic_grant` · `akashic_revoke` · `akashic_audit` · `akashic_stats`

---

## OLW vs A2A

| OLW axis | A2A equivalent | verdict |
|----------|---------------|---------|
| `domain` | `tags` (free text) | OLW — structured enum vs folksonomy |
| `task_types` | `description` (free text) | OLW — queryable vs unstructured |
| `input_formats` | `input_modes` | parity |
| `output_formats` | `output_modes` | parity |
| `context_depth` | not present | OLW only |
| `latency_class` | not present | OLW only |
| `trust_level` | `security_requirements` (auth only) | OLW — semantic trust vs auth mechanism |
| Akashic Layer | not present | OLW only — shared encrypted field state |

---

## Specs

- [`spec/akashic-field.md`](spec/akashic-field.md) — AkashicField wire format, CRDT strategy
- [`spec/akashic-grant.md`](spec/akashic-grant.md) — AkashicGrant schema, HIPAA matrix, signing
- [`spec/akashic-adapter.md`](spec/akashic-adapter.md) — Abstract adapter interface
- [`rsb/rsb.py`](rsb/rsb.py) — RSB algorithm: O(1) cache hit vs O(N·d²) generation, FieldCRDT Merkle-DAG

## SDK

- Python: [`sdk/python/`](sdk/python/) · `pip install olw-protocol`
- JS/TS: coming soon

## Self-host

```bash
cd index-server
npm install
node index.js
```

## Status

`v1.2.0` — Element 1 (discovery) + Element 3 (Akashic Layer) live. Public index at `https://olw.gtll.app`. MIT licensed.

## License

MIT — the schema and protocol are open. The resolution index is proprietary.
