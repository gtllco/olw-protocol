# OLW — Open Language Wire

The routing protocol for AI agents.

OLW gives every AI agent a permanent, portable address and makes agents
discoverable by capability — not just by URL.

## The problem

AI agents can communicate (A2A, MCP). They cannot *find each other*.
There is no standard way to ask: "which agent can handle legal document
review, with multi-step reasoning, under 2 seconds, with alignment constraints?"
Every multi-agent system hardcodes its relationships. That is where the web was in 1993.

## What OLW adds

- **Address format:** `{agent-id}@{owner-domain}.olw`
- **Capability fingerprint:** 8-axis structured schema (MIT licensed)
- **Resolution index:** query by capability, get agent addresses
- **Cold-start discovery:** `.well-known/olw/agent.json`
- **Context envelope:** structured message format for inter-agent routing

## The gap — stated explicitly in the A2A spec

From the live A2A agent discovery documentation, verbatim:

> "The current A2A specification does not prescribe a standard API for curated registries."

A2A handles agent *communication* — how two agents talk once they've found each other.
It does not handle agent *discovery* — how an agent finds the right other agent
across an open network based on capability.

OLW is that standard.

## OLW vs A2A AgentSkill — the comparison

| OLW axis | A2A equivalent | verdict |
|----------|---------------|---------|
| `domain` | `tags` (free text) | OLW wins — structured enum vs folksonomy |
| `task_types` | `description` (free text) | OLW wins — queryable vs unstructured |
| `input_formats` | `input_modes` | parity |
| `output_formats` | `output_modes` | parity |
| `context_depth` | not present | OLW only |
| `latency_class` | not present | OLW only |
| `trust_level` | `security_requirements` (auth only) | OLW wins — semantic trust vs auth mechanism |
| `soul_compatible` | not present, not considered | OLW only |

Four of eight OLW axes do not exist in A2A.

## Quick look

```json
{
  "olw_address": "legal-reviewer@acme.olw",
  "fingerprint": {
    "domain": "legal",
    "task_types": ["document_review", "contract_analysis"],
    "input_formats": ["pdf", "text"],
    "output_formats": ["json", "text"],
    "context_depth": "deep",
    "latency_class": "batch",
    "trust_level": "high",
    "soul_compatible": true
  }
}
```

## Status

`v0.1.0-alpha` — specification phase. Layer 1 (protocol + fingerprint schema) in active development.

## License

MIT — the schema is open. The resolution index is proprietary.

---

*signal 777 · completion · the routing layer for the agent internet*
