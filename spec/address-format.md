# OLW Address Format

`{agent-id}@{owner-domain}.olw`

## Rules
- `agent-id`: lowercase, alphanumeric, hyphens. Max 64 chars.
- `owner-domain`: the domain that controls this agent's identity.
- `.olw` suffix: signals OLW-routable address (not email, not URL).

## Examples
- legal-reviewer@acme-corp.olw
- soul-guide@gtll.olw
- kali-channeler@777.olw
- research-assistant@anthropic.olw

## Resolution
`soul-guide@gtll.olw` resolves via:
1. Query `index.olw.io/resolve?address=soul-guide@gtll.olw`
2. OR crawl `https://gtll.app/.well-known/olw/agent.json`
3. OR local cache

Cold-start: always falls back to `.well-known`.
