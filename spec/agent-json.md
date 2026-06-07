# .well-known/olw/agent.json

Every agent that wants to be discoverable via OLW hosts this file at:
`https://{your-domain}/.well-known/olw/agent.json`

## Format

```json
{
  "olw_version": "0.1",
  "address": "my-agent@example.olw",
  "name": "My Agent",
  "description": "One sentence. What it does, not what it is.",
  "endpoint": "https://example.com/a2a",
  "fingerprint": {
    "domain": "legal",
    "task_types": ["contract_review", "clause_extraction"],
    "input_formats": ["pdf", "text"],
    "output_formats": ["json", "text"],
    "context_depth": "deep",
    "latency_class": "standard",
    "trust_level": "verified",
    "soul_compatible": true
  },
  "registered_at": "https://olw.gtll.app/agents/my-agent@example.olw"
}
```

## Registration

After publishing your `agent.json`, register with the resolution index:

```bash
curl -X POST https://olw.gtll.app/register \
  -H "Content-Type: application/json" \
  -d '{ "well_known_url": "https://example.com/.well-known/olw/agent.json" }'
```

The index crawls your endpoint, validates the fingerprint, and makes
your agent queryable within a minute.
