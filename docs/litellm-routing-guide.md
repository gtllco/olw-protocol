# OLW → LiteLLM Routing Guide

**LiteLLM runs at** `http://localhost:4000` (alias: Token Factory). Do not kill or edit without explicit authorization — it is the shared LLM gateway for the entire GTLL ecosystem.

## How OLW Routes Through LiteLLM

OLW's `/orbitRoute` endpoint (served by `orbit-api` at port 3100) applies the 777·555·333 signal model:

| Signal | Model | Use Case |
|--------|-------|----------|
| 777 | `claude-sonnet-4-5` | Customer-facing, production, deal coaching |
| 555 | `grok-2` | Creative risk, pattern breaks, brainstorming |
| 333 | `gemini-flash-2.0` | Foundation, batch work, summaries |

Requests flow: **Client → orbit-api :3100 → LiteLLM :4000 → Provider**

## LiteLLM Endpoint Reference

```
POST http://localhost:4000/v1/chat/completions
Authorization: Bearer <LITELLM_API_KEY>
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "messages": [{ "role": "user", "content": "..." }]
}
```

### Available Models (via LiteLLM aliases)
- `claude-sonnet-4-5` → Anthropic Claude Sonnet (777 signal)
- `grok-2` → xAI Grok (555 signal)  
- `gemini-flash-2.0` → Google Gemini Flash (333 signal)

## OLW Index Server Integration

The OLW index server does **not** call LiteLLM directly. All LLM routing goes through:

```
POST http://localhost:3100/orbitLLM
x-neural-secret: ILOVEYOUSAMUEL
Content-Type: application/json

{
  "signal": "777",           // or "555" or "333"
  "messages": [...],
  "system": "optional system prompt"
}
```

orbitLLM resolves the signal to a model and routes through LiteLLM at :4000.

## Nexus (graph.gtll.app) LLM Routing

Nexus at port 6000 uses LiteLLM as its Anthropic provider:
- `litellm` (port 4000) → Anthropic calls
- `ollama` (port 11434) → Local inference

## Adding a New Model Route

1. Add the model alias to LiteLLM config (ask Gabe — do not touch litellm directly)
2. Update `orbitRoute` in `/opt/gtll-api/server.js` to map your signal → new alias
3. Test: `curl -X POST http://localhost:3100/orbitRoute -H 'x-neural-secret: ILOVEYOUSAMUEL' -d '{"signal":"333","prompt":"test"}'`

## Do Not Touch

- Port 4000 process — it proxies all LLM traffic for GTLL + nexus + n8n
- LiteLLM config file — changes require explicit instruction from Gabe
- The `LITELLM_API_KEY` — stored in `/etc/gtll/` secrets, do not log or commit
