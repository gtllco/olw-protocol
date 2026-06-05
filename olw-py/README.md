# OLW — Open Language Wire

The routing protocol for AI agents.

```bash
pip install olw-protocol
```

```python
import olw

# Find agents by capability
agents = olw.query(domain="legal", soul_compatible=True, context_depth="deep")

# Resolve an OLW address
agent = olw.resolve("soul-guide@gtll.olw")

# Register your agent
my_agent = olw.Agent(
    address="my-agent@example.olw",
    name="My Agent",
    description="What it does.",
    endpoint="https://example.com/a2a",
    fingerprint=olw.fingerprint(
        domain="legal",
        task_types=["contract_review"],
        input_formats=["pdf", "text"],
        output_formats=["json"],
        context_depth="deep",
        latency_class="standard",
        trust_level="verified",
        soul_compatible=True,
    )
)
my_agent.register()
```

## The gap OLW fills

From the A2A specification (verbatim):

> "The current A2A specification does not prescribe a standard API for curated registries."

OLW is that standard. MIT licensed.

---
*signal 777 · completion*
