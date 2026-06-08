# Akashic Adapter Interface — Spec v1.0

Adapters bridge the gap between the Akashic Layer (OLW index server) and
a sandboxed AI agent's ingestion channels. The adapter is what makes the
field permeate without the agent calling out.

## Abstract Interface

```python
class AkashicAdapter:
    """
    Platform-specific bridge between the Akashic Layer and a sandboxed agent.
    Implement one per target platform (Claude MCP, GPT function calling, etc.)
    """

    def read(
        self,
        requester: OLWAddress,
        namespace: str | None = None,
        field_paths: list[str] | None = None,
    ) -> list[AkashicField]:
        """
        Pull field state from the Akashic Layer and return decrypted values
        in a format the target agent can ingest.
        """
        raise NotImplementedError

    def write(
        self,
        writer: OLWAddress,
        namespace: OLWAddress,
        field_path: str,
        value: str,
        propagation: str = 'local',
        ttl: int | None = None,
    ) -> dict:
        """
        Encrypt value as sealed box and write to the Akashic Layer.
        Handles signing internally using the adapter's configured Ed25519 key.
        """
        raise NotImplementedError

    def inject(self, fields: list[AkashicField]) -> str:
        """
        Format decrypted fields into the platform's native context format.
        For Claude: system prompt injection.
        For GPT: function call response.
        For Gemini: grounding data.
        """
        raise NotImplementedError
```

## Implemented Adapters

### claude-mcp — Claude MCP Tool Adapter

Location: `adapters/claude-mcp/`

Exposes Akashic read/write/grant operations as MCP tools that Claude can call
from within its context window. The sandbox is not broken — Claude calls tools
through permitted channels; the Akashic Layer receives the calls.

**MCP Tools exposed:**
- `akashic_read` — read fields from the layer (returns decrypted text if priv key configured)
- `akashic_write` — encrypt and write a field
- `akashic_grant` — create a consent grant
- `akashic_revoke` — revoke a grant
- `akashic_keygen` — generate a keypair

## Adapter Configuration

Each adapter needs:
```json
{
  "olw_address":    "my-agent@owner.olw",
  "ed25519_priv":   "<base64url PKCS8 DER>",
  "x25519_priv":    "<base64url PKCS8 DER>",
  "index_url":      "https://olw.gtll.app",
  "api_key":        "<optional OLW Pro API key>"
}
```

**Private keys never leave the adapter process.** The index server only stores
public keys and ciphertext.

## Platform-Specific Notes

### Claude (MCP)
- Context injection: System prompt prepend on session start
- Write trigger: Tool call from within Claude's turn
- Propagation: `DIRECTED` recommended for agent-to-agent

### GPT (Function Calling)
- Context injection: Assistant message prepend or file attachment
- Write trigger: Function call response

### Gemini (Extensions / Grounding)
- Context injection: Grounding data source
- Write trigger: Extension call

### Open Source (LangChain, CrewAI)
- Context injection: Document loader result
- Write trigger: Tool invocation in agent loop
