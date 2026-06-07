#!/usr/bin/env python3
"""OLW Demo — agent discovers another agent by capability, then routes a task."""

import httpx, sys

INDEX = "http://localhost:3778"

print("\n=== OLW Routing Demo ===\n")

# --- Step 1: Discover by capability ---
print("Agent A needs a finance agent that handles summarization in under 30s.")
print("Querying OLW index for: domain=finance, latency_class=standard\n")

try:
    r = httpx.get(f"{INDEX}/query",
                  params={"domain": "finance", "latency_class": "standard"},
                  timeout=5)
    results = r.json()
    print(f"Index returned {results['count']} agent(s):\n")
    for agent in results["agents"]:
        print(f"  Address:     {agent['address']}")
        print(f"  Name:        {agent['name']}")
        print(f"  Endpoint:    {agent['endpoint']}")
        print(f"  Task types:  {agent['fingerprint']['task_types']}")
        print(f"  Trust level: {agent['fingerprint']['trust_level']}")
        print()
except Exception as e:
    print(f"  Index error: {e}")
    sys.exit(1)

# --- Step 2: Resolve a specific address ---
print("Agent A: Resolving orbit-router@gtll.olw directly...\n")
try:
    r = httpx.get(f"{INDEX}/resolve",
                  params={"address": "orbit-router@gtll.olw"},
                  timeout=5)
    agent = r.json()
    print(f"  Resolved to: {agent['endpoint']}")
    print(f"  Context depth: {agent['fingerprint']['context_depth']}")
    print(f"  Latency class: {agent['fingerprint']['latency_class']}")
except Exception as e:
    print(f"  Resolve error: {e}")

# --- Step 3: Cold-start .well-known fallback ---
print("\nAgent A: Attempting cold-start resolution (no index required)...\n")
try:
    r = httpx.get("https://777.gtll.app/.well-known/olw/agent.json", timeout=5)
    data = r.json()
    print(f"  .well-known resolved: {data.get('address')}")
    print(f"  Endpoint: {data.get('endpoint')}")
except Exception as e:
    print(f"  .well-known unavailable: {e}")

print("\n=== OLW: find → resolve → route. ===\n")
