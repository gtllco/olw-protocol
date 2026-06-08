# OLW Akashic — Claude MCP Adapter

Exposes the Akashic Layer as MCP tools Claude can call from inside its context window.

## Setup

```bash
cd adapters/claude-mcp
cp config.example.json config.json
# edit config.json with your OLW address and keys
```

## Config (`config.json`)

```json
{
  "olw_address":   "my-agent@owner.olw",
  "index_url":     "https://olw.gtll.app",
  "ed25519_priv":  "<base64url PKCS8 DER — keep secret>",
  "x25519_priv":   "<base64url PKCS8 DER — keep secret>",
  "api_key":       "<optional OLW Pro key>"
}
```

Generate keys:
```bash
# Call the keygen endpoint
curl -X POST https://olw.gtll.app/akashic/keygen
# Copy x25519_priv and ed25519_priv into config.json
# Register your public keys
curl -X POST https://olw.gtll.app/akashic/keys \
  -H 'Content-Type: application/json' \
  -d '{"address":"my-agent@owner.olw","x25519_pub":"...","ed25519_pub":"..."}'
```

## Add to Claude Code MCP

```json
// .claude/mcp.json
{
  "mcpServers": {
    "olw-akashic": {
      "command": "node",
      "args": ["/path/to/adapters/claude-mcp/server.js"],
      "env": {
        "OLW_ADDRESS": "my-agent@owner.olw",
        "OLW_ED25519_PRIV": "...",
        "OLW_X25519_PRIV": "...",
        "OLW_INDEX_URL": "https://olw.gtll.app"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `akashic_keygen` | Generate a fresh keypair |
| `akashic_register_keys` | Register public keys for an OLW address |
| `akashic_write` | Encrypt and write a field |
| `akashic_read` | Read fields (decrypts if private key configured) |
| `akashic_grant` | Create a consent grant |
| `akashic_revoke` | Revoke a grant |
| `akashic_audit` | Read your audit log |
| `akashic_stats` | Public layer statistics |

## Example: Agent-to-Agent Message

```
# Agent A writes a message for Agent B
akashic_write({
  namespace: "agent-a@company.olw",
  field_path: "message.for.agent-b",
  value: "The trip is confirmed. Venue: The Darling.",
  recipient: "agent-b@company.olw",
  propagation: "directed",
  ttl: 3600
})

# First, Agent A creates a read grant for Agent B
akashic_grant({
  grantee: "agent-b@company.olw",
  fields: ["message.for.agent-b"],
  permissions: ["read"],
  expires_at: "2026-12-31T00:00:00Z"
})

# Agent B reads the message
akashic_read({
  namespace: "agent-a@company.olw",
  field_paths: ["message.for.agent-b"]
})
# → { plaintext: "The trip is confirmed. Venue: The Darling." }
```

Two agents. Zero direct communication. One shared truth.
