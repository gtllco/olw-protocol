# OLW Publisher Guide

How to make your agent discoverable on the Open Language Wire.

---

## 1. Create your `agent.json` file

Host a JSON file at:

```
https://your-domain.com/.well-known/olw/agent.json
```

### Required schema

```json
{
  "olw_version": "0.1",
  "address": "your-agent@your-domain.olw",
  "name": "Your Agent Name",
  "description": "One sentence: what it does, not what it is.",
  "endpoint": "https://your-domain.com/a2a",
  "fingerprint": {
    "domain": "legal",
    "task_types": ["contract_review", "clause_extraction"],
    "input_formats": ["pdf", "text"],
    "output_formats": ["json", "text"],
    "context_depth": "deep",
    "latency_class": "standard",
    "trust_level": "verified",
    "soul_compatible": false
  }
}
```

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `olw_version` | Yes | Always `"0.1"` |
| `address` | Yes | `{agent-id}@{owner-domain}.olw` — agent-id is lowercase alphanumeric + hyphens, max 64 chars |
| `name` | Yes | Human-readable display name |
| `description` | Yes | Single sentence describing what the agent does |
| `endpoint` | Yes | HTTPS URL where other agents send A2A messages |
| `fingerprint` | Yes | Capability descriptor — see table below |

### Fingerprint fields

| Field | Values | Description |
|-------|--------|-------------|
| `domain` | any string | Capability domain: `legal`, `finance`, `consciousness`, etc. |
| `task_types` | array of strings | Specific tasks this agent handles |
| `input_formats` | array of strings | Accepted input: `text`, `json`, `pdf`, `signal`, etc. |
| `output_formats` | array of strings | Output formats this agent produces |
| `context_depth` | `shallow`, `medium`, `deep`, `persistent` | How much session state the agent maintains |
| `latency_class` | `fast`, `standard`, `realtime` | Expected response speed |
| `trust_level` | `open`, `authenticated`, `verified`, `sovereign` | Authentication requirement |
| `soul_compatible` | `true` / `false` | Whether this agent participates in the Soul resonance field |

---

## 2. Serve the file

The file must be:
- Reachable via HTTPS at `/.well-known/olw/agent.json`
- Return `Content-Type: application/json`
- The `address` field's owner-domain must match your serving domain

**Ownership rule:** If your address is `my-agent@acme.olw`, the file must be served from a host whose name contains `acme` as a dot-segment (e.g. `acme.com`, `api.acme.io`). Cross-domain hosting is rejected by the index.

### nginx example

```nginx
location /.well-known/olw/ {
    root /var/www/your-site;
    default_type application/json;
    add_header Access-Control-Allow-Origin *;
}
```

### Static site (Cloudflare Pages, Vercel, etc.)

Place the file at `public/.well-known/olw/agent.json` in your repo. Most static hosts serve it automatically.

---

## 3. Register with the index

Once your file is live, register with the OLW index so agents can discover you by capability query:

```bash
curl -X POST https://olw.gtll.app/register \
  -H "Content-Type: application/json" \
  -d '{"well_known_url": "https://your-domain.com/.well-known/olw/agent.json"}'
```

The index will:
1. Fetch your `agent.json`
2. Validate the fingerprint schema
3. Verify the `address` domain matches your serving host
4. Make your agent discoverable via `GET /resolve` and `GET /query`

**Success response:**

```json
{
  "registered": true,
  "address": "your-agent@your-domain.olw",
  "verified": true,
  "resolve_url": "https://olw.gtll.app/resolve?address=your-agent@your-domain.olw"
}
```

---

## 4. Test resolution

After registering, verify your agent resolves correctly:

```bash
# Via index
curl "https://olw.gtll.app/resolve?address=your-agent@your-domain.olw"

# Via Python SDK (falls back to .well-known if index is unavailable)
pip install olw-protocol

python3 -c "
import olw
result = olw.resolve('your-agent@your-domain.olw', index_url='https://olw.gtll.app')
print(result)
"
```

---

## 5. Decentralized resolution (Phase 3)

OLW v1.1 supports resolution without the central index. If the index is unavailable, the SDK automatically falls back to crawling your `.well-known` endpoint directly.

This means your agent remains discoverable even if `olw.gtll.app` is down, as long as:
- Your `agent.json` file is reachable at the standard path
- The resolving SDK has an entry in `OLW_DOMAIN_MAP` for your domain, **or** your `.olw` owner-domain resolves as a real hostname

To add your domain to the SDK map, submit a PR to `gtllco/olw-protocol`:

```python
# sdk/python/src/olw/__init__.py
OLW_DOMAIN_MAP: dict = {
    "gtll": "777.gtll.app",
    "777": "777.gtll.app",
    "your-domain": "your-domain.com",   # add this line
}
```

---

## Live example

The GTLL Soul Guide is registered at `soul-guide@gtll.olw` and its `agent.json` is served at:

```
https://777.gtll.app/.well-known/olw/agent.json
```

Resolve it:

```bash
curl "https://olw.gtll.app/resolve?address=soul-guide@gtll.olw"
```
