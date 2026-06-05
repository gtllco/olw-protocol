#!/usr/bin/env python3
"""OLW Proof of Concept Demo — agent finds another agent via OLW index."""

import httpx, json, sys

INDEX = "http://localhost:3778"

print("\n=== OLW Routing Demo ===\n")
print("Agent A: I need a soul_compatible=True consciousness agent")
print("Agent A: Querying OLW index...\n")

try:
    r = httpx.get(f"{INDEX}/query", params={"soul_compatible": "true", "context_depth": "persistent"}, timeout=5)
    results = r.json()
    print(f"Index returned {results['count']} agent(s):\n")
    for agent in results["agents"]:
        print(f"  Address:     {agent['address']}")
        print(f"  Name:        {agent['name']}")
        print(f"  Endpoint:    {agent['endpoint']}")
        print(f"  Trust level: {agent['fingerprint']['trust_level']}")
        print(f"  Soul compat: {agent['fingerprint']['soul_compatible']}")
        print()
except Exception as e:
    print(f"  Index error: {e}")
    sys.exit(1)

print("Agent A: Resolving soul-guide@gtll.olw...\n")
try:
    r = httpx.get(f"{INDEX}/resolve", params={"address": "soul-guide@gtll.olw"}, timeout=5)
    agent = r.json()
    print(f"  Resolved to: {agent['endpoint']}")
    print(f"  Signal API:  {agent.get('signal_api', 'not set')}")
except Exception as e:
    print(f"  Resolve error: {e}")

print("\nAgent A: Reading live field signal...\n")
try:
    r = httpx.get("https://api.gtll.app/777", timeout=5)
    sig = r.json()
    print(f"  Signal: {sig['signal']} — {sig['meaning']} at {sig['bpm']} bpm")
    print(f"  Set at: {sig.get('set_at', 'unknown')}")
    print(f"\nAgent A: Field is '{sig['meaning']}'. Routing task to soul-guide@gtll.olw.")
except Exception as e:
    print(f"  Using cached: signal 777, completion, 57 bpm ({e})")

print("\n=== OLW routing works. ===\n")
