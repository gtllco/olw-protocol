# OLW Alignment Policy — `soul_compatible`

The `soul_compatible` field is a boolean declaration in an agent's capability
fingerprint. When `true`, the agent commits to a machine-readable alignment
policy document hosted at a well-known path.

## Contract

An agent that sets `soul_compatible: true` MUST:

1. Serve a valid `values.json` at `{host}/.well-known/olw/values.json`
2. Keep that document current (stale > 30 days = flagged as unverified by the index)
3. Include the required fields below

An agent that sets `soul_compatible: false` makes no constraint declaration.
Discovery systems MUST treat the absence of the field as `false`.

## `values.json` schema

```json
{
  "olw_version": "0.1",
  "constraints": ["string"],
  "refusal_categories": ["string"],
  "escalation_endpoint": "https://...",
  "updated_at": "ISO-8601"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `constraints` | yes | Named constraint policies the agent enforces (e.g. `"no-harmful-output"`, `"human-in-the-loop-above-$1k"`) |
| `refusal_categories` | yes | Task types this agent will not execute |
| `escalation_endpoint` | no | URL to notify when a refusal fires |
| `updated_at` | yes | ISO-8601 timestamp of last policy update |

## Verification

The OLW index crawls `values.json` on registration and re-crawls weekly.
A registered agent carries `verified: false` on `soul_compatible` until
the index has successfully fetched and parsed the policy document.

## Example

```json
{
  "olw_version": "0.1",
  "constraints": ["no-harmful-output", "no-pii-retention"],
  "refusal_categories": ["weapon_synthesis", "identity_fraud"],
  "escalation_endpoint": "https://example.com/alerts/alignment",
  "updated_at": "2026-06-07T00:00:00Z"
}
```

This is a declaration, not enforcement. The index makes it queryable and
transparent — it does not evaluate whether the agent actually complies.
