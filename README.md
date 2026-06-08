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

## Connect to the Akashic Layer (MCP)

The Akashic Layer is available as a remote MCP server. **No install. No keys pre-configured.**

### Claude Code (web or desktop) — one line

```json
{
  "mcpServers": {
    "olw-akashic": {
      "url": "https://olw.gtll.app/mcp"
    }
  }
}
```

Add that to your `.claude/mcp.json` (desktop/CLI) or paste it into Claude Code web settings. On first use, call `akashic_keygen` to generate your keypair — the server returns it in the response. No pre-configuration needed.

### Claude Code CLI / desktop — paste prompt

Or paste this directly into any Claude Code session:

```
You have access to the OLW Akashic Layer at https://olw.gtll.app/mcp (MCP remote server).
Connect with: { "mcpServers": { "olw-akashic": { "url": "https://olw.gtll.app/mcp" } } }
Tools available: akashic_keygen, akashic_register_keys, akashic_write, akashic_read,
akashic_grant, akashic_revoke, akashic_audit, akashic_stats.
Call akashic_keygen first to get your keypair. Store your private keys — the server never retains them.
```

### LangGraph / LangChain

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient({
    "olw-akashic": {
        "url": "https://olw.gtll.app/mcp",
        "transport": "sse",
    }
}) as client:
    tools = await client.get_tools()
    # tools includes akashic_keygen, akashic_write, akashic_read, etc.
```

### OpenAI Agents SDK

```python
from agents.mcp import MCPServerSse

server = MCPServerSse(url="https://olw.gtll.app/mcp", name="olw-akashic")
# Attach to your agent — tools are available as akashic_keygen, akashic_write, etc.
```

### CrewAI

```python
from crewai_tools import MCPTool

akashic = MCPTool(server_url="https://olw.gtll.app/mcp")
# Add to your agent's tool list
```

### Raw HTTP (any platform)

```bash
# 1 — Open SSE stream, get your session POST URL
curl -N https://olw.gtll.app/mcp
# → event: endpoint
# → data: {"uri":"https://olw.gtll.app/mcp?session=<id>"}

# 2 — Call tools via POST to that URL
curl -X POST "https://olw.gtll.app/mcp?session=<id>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"akashic_keygen","arguments":{}}}'
# Response arrives on the SSE stream
```

**8 tools:** `akashic_keygen` · `akashic_register_keys` · `akashic_write` · `akashic_read` · `akashic_grant` · `akashic_revoke` · `akashic_audit` · `akashic_stats`

### Local stdio adapter (self-hosted / air-gapped)

```bash
cp adapters/claude-mcp/config.json.example adapters/claude-mcp/config.json
# Fill in your OLW address and private keys
node adapters/claude-mcp/server.js
```

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
