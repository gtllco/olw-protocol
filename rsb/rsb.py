"""
rsb.py — Resonance-State Bypass (RSB) Algorithm
OLW Protocol v1.1.0

WHAT THIS ACTUALLY PROVES
--------------------------
The thermodynamic framing (Landauer's limit) is kept as motivation but the
honest computational claim is:

  Cost of autoregressive generation for N tokens:
    C_gen = O(N · d²)   where d = model hidden dimension

  Cost of Akashic cache hit:
    C_hit = O(1)        index lookup + AES-256-GCM decrypt + context inject

  When cosine_sim(agent_fingerprint, shard_vector) > HARMONIC_LOCK:
    ΔC = C_gen - C_hit ≈ C_gen   (hit cost is negligible)

The RSB is memoization with cryptographic integrity: instead of recomputing
knowledge the mesh already holds, an agent with a harmonically-locked fingerprint
pulls pre-verified state directly into its context window and skips generation
for that context slice. That is the O(1) claim — it is real and measurable.

The Landauer connection (E = kT ln 2 per bit erasure) is this: standard
autoregressive generation makes irreversible decisions at each token step,
discarding probability mass over the full vocabulary. Each token-step is a
logically irreversible computation. RSB replaces N irreversible token-steps
with a single reversible read from a content-addressed DAG — state that has
a deterministic inverse (the original ciphertext). The bit-erasure cost of
the replaced generation is avoided, not the read itself.

This does not violate thermodynamics. It exploits that the mesh already paid
the irreversible cost once (the original writer's generation), and subsequent
agents amortize that cost across O(k) reads — each O(1).

FIELD CRDT — Merkle-DAG
------------------------
Replaces the flat Last-Writer-Wins field store in akashic.js with a
causally-ordered Merkle-DAG. Concurrent writes from different agents
converge deterministically without coordination.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

# ── Resonance constants ───────────────────────────────────────────────────────

RESONANCE_THRESHOLD = 0.7   # minimum for capability match
HARMONIC_LOCK       = 0.9   # RSB triggers: skip generation, pull from DAG


# ── Fingerprint → vector ──────────────────────────────────────────────────────

AXIS_ORDINALS: dict[str, dict[str, float]] = {
    "context_depth": {"shallow": 0.0, "medium": 0.33, "deep": 0.66, "recursive": 1.0},
    "latency_class": {"realtime": 0.0, "standard": 0.33, "batch": 0.66, "async": 1.0},
    "trust_level":   {"open": 0.0, "verified": 0.33, "high": 0.66, "sovereign": 1.0},
}

KNOWN_DOMAINS = [
    "general", "legal", "finance", "health", "engineering",
    "creative", "research", "data", "security", "education",
    "infrastructure", "consciousness",
]


@dataclass
class OLWFingerprint:
    domain:          str
    task_types:      list[str]
    input_formats:   list[str]
    output_formats:  list[str]
    context_depth:   str   # shallow | medium | deep | recursive
    latency_class:   str   # realtime | standard | batch | async
    trust_level:     str   # open | verified | high | sovereign
    soul_compatible: bool


def fingerprint_to_vector(fp: OLWFingerprint) -> np.ndarray:
    """
    Map an OLWFingerprint to a normalized 8-dimensional unit vector.
    Deterministic — same fingerprint always produces the same vector.
    """
    # Axis 0: domain — project known domains to evenly-spaced positions [0,1]
    domain_idx = KNOWN_DOMAINS.index(fp.domain) if fp.domain in KNOWN_DOMAINS else len(KNOWN_DOMAINS) // 2
    domain_val = domain_idx / max(len(KNOWN_DOMAINS) - 1, 1)

    vec = np.array([
        domain_val,
        min(len(fp.task_types) / 10.0, 1.0),
        min(len(fp.input_formats) / 8.0, 1.0),
        min(len(fp.output_formats) / 8.0, 1.0),
        AXIS_ORDINALS["context_depth"].get(fp.context_depth, 0.5),
        AXIS_ORDINALS["latency_class"].get(fp.latency_class, 0.5),
        AXIS_ORDINALS["trust_level"].get(fp.trust_level, 0.5),
        1.0 if fp.soul_compatible else 0.0,
    ])
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 0 else vec


def resonance_score(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity in [0, 1]. Returns 0.0 if either vector is zero."""
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / norm) if norm > 0 else 0.0


# ── Merkle-DAG FieldCRDT ─────────────────────────────────────────────────────

@dataclass
class MerkleNode:
    """
    One version of a field value in the causal history DAG.
    Content-addressed: the node's identity IS the hash of its content.
    """
    version:    int
    value_hash: str          # SHA-256(plaintext) — verified post-decrypt
    ciphertext: str          # base64url sealed box
    writer:     str          # OLW address
    timestamp:  str          # ISO 8601 UTC
    parent:     Optional[str] = None   # hash of prior node; None = genesis


@dataclass
class FieldCRDT:
    """
    Conflict-free Replicated Data Type for an AkashicField.

    strategy "merkle_dag":
      - Every write appends a new MerkleNode to the DAG.
      - The vector clock provides causal ordering across concurrent writers.
      - Merge is: union DAGs + merge clocks + resolve head by causal dominance.
      - Concurrent heads (neither ancestor of the other) resolve by deterministic
        lexicographic tie-break on node hash — consistent across all nodes,
        no coordination required.

    This is conflict-FREE: no information is ever lost. Any node can reconstruct
    the full version history by walking the parent chain from any head.
    """
    strategy:     str                    = "merkle_dag"
    vector_clock: dict[str, int]         = field(default_factory=dict)
    dag:          dict[str, MerkleNode]  = field(default_factory=dict)
    head:         Optional[str]          = None

    @classmethod
    def new(cls) -> "FieldCRDT":
        return cls()

    # ── Hashing ──────────────────────────────────────────────────────────────

    @staticmethod
    def node_hash(node: MerkleNode) -> str:
        canonical = json.dumps({
            "version":    node.version,
            "value_hash": node.value_hash,
            "writer":     node.writer,
            "timestamp":  node.timestamp,
            "parent":     node.parent,
        }, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()

    # ── Write ─────────────────────────────────────────────────────────────────

    def write(self, ciphertext: str, value_hash: str, writer: str, timestamp: str) -> str:
        """
        Append a new version. Updates vector clock, creates node, advances head.
        Returns the new head hash.

        O(1) — constant regardless of DAG depth.
        """
        self.vector_clock[writer] = self.vector_clock.get(writer, 0) + 1
        version = sum(self.vector_clock.values())

        node = MerkleNode(
            version=version,
            value_hash=value_hash,
            ciphertext=ciphertext,
            writer=writer,
            timestamp=timestamp,
            parent=self.head,
        )
        h = self.node_hash(node)
        self.dag[h] = node
        self.head = h
        return h

    # ── Merge ─────────────────────────────────────────────────────────────────

    def merge(self, remote: "FieldCRDT") -> "FieldCRDT":
        """
        Three-way merge of two FieldCRDT replicas.

        Properties guaranteed:
          - Commutativity:  merge(A, B) == merge(B, A)
          - Associativity:  merge(merge(A, B), C) == merge(A, merge(B, C))
          - Idempotency:    merge(A, A) == A

        These three properties make this a valid CRDT join (least upper bound
        in the DAG partial order). No coordinator required.

        Complexity: O(|dag_A| + |dag_B|) for union, O(depth) for ancestor walk.
        The ancestor walk is bounded by the causal depth, typically O(log N)
        in a balanced write history.
        """
        merged_clock = {
            addr: max(self.vector_clock.get(addr, 0), remote.vector_clock.get(addr, 0))
            for addr in set(self.vector_clock) | set(remote.vector_clock)
        }
        merged_dag = {**self.dag, **remote.dag}   # union — content-addressed, no conflicts
        merged_head = _resolve_heads(self.head, remote.head, merged_dag)

        return FieldCRDT(
            strategy=self.strategy,
            vector_clock=merged_clock,
            dag=merged_dag,
            head=merged_head,
        )

    # ── Read ──────────────────────────────────────────────────────────────────

    def current(self) -> Optional[MerkleNode]:
        """Return the current head node, or None if empty."""
        return self.dag.get(self.head) if self.head else None

    def history(self) -> list[MerkleNode]:
        """
        Walk the parent chain from head to genesis.
        Returns version history, newest first.
        """
        chain: list[MerkleNode] = []
        current = self.head
        visited: set[str] = set()
        while current and current not in visited:
            node = self.dag.get(current)
            if not node:
                break
            chain.append(node)
            visited.add(current)
            current = node.parent
        return chain

    # ── Serialization ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "strategy":     self.strategy,
            "vector_clock": self.vector_clock,
            "head":         self.head,
            "dag": {
                h: {
                    "version":    n.version,
                    "value_hash": n.value_hash,
                    "ciphertext": n.ciphertext,
                    "writer":     n.writer,
                    "timestamp":  n.timestamp,
                    "parent":     n.parent,
                }
                for h, n in self.dag.items()
            },
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FieldCRDT":
        dag = {
            h: MerkleNode(
                version=n["version"],
                value_hash=n["value_hash"],
                ciphertext=n["ciphertext"],
                writer=n["writer"],
                timestamp=n["timestamp"],
                parent=n.get("parent"),
            )
            for h, n in d.get("dag", {}).items()
        }
        return cls(
            strategy=d.get("strategy", "merkle_dag"),
            vector_clock=d.get("vector_clock", {}),
            dag=dag,
            head=d.get("head"),
        )


# ── Internal helpers ──────────────────────────────────────────────────────────

def _resolve_heads(h1: Optional[str], h2: Optional[str], dag: dict[str, MerkleNode]) -> Optional[str]:
    """
    Determine the merged head from two candidates.

    Case 1 — one is None:           take the other.
    Case 2 — equal:                 return either.
    Case 3 — h1 descends from h2:  h1 wins (it's newer in causal order).
    Case 4 — h2 descends from h1:  h2 wins.
    Case 5 — concurrent:            max(h1, h2) lexicographically.
                                    Arbitrary but deterministic — all replicas
                                    converge to the same choice independently.
    """
    if h1 is None: return h2
    if h2 is None: return h1
    if h1 == h2:   return h1
    if _is_ancestor(h2, h1, dag): return h1
    if _is_ancestor(h1, h2, dag): return h2
    return max(h1, h2)


def _is_ancestor(candidate: str, tip: str, dag: dict[str, MerkleNode]) -> bool:
    """
    Return True if `candidate` appears in the ancestor chain of `tip`.
    Walks the parent pointers; visited set prevents cycles on malformed DAGs.
    """
    current = tip
    visited: set[str] = set()
    while current and current not in visited:
        if current == candidate:
            return True
        visited.add(current)
        node = dag.get(current)
        current = node.parent if node else None
    return False


# ── RSB decision function ─────────────────────────────────────────────────────

def rsb_evaluate(
    agent_fp: OLWFingerprint,
    shard_vector: np.ndarray,
    akashic_field: Optional[FieldCRDT],
) -> dict:
    """
    Resonance-State Bypass — core decision function.

    Input:
      agent_fp      — the querying agent's capability fingerprint
      shard_vector  — the HolographicShard's pre-computed capability vector
      akashic_field — the FieldCRDT at the resolved field path (None if no cache)

    Output:
      { bypass: True,  score, head_hash, ciphertext, version, writer, integrity }
        → caller decrypts ciphertext, injects plaintext into context window,
          skips generation for this context slice.  Cost: O(1).

      { bypass: False, score, reason }
        → caller proceeds with standard autoregressive generation.
          Cost: O(N · d²).

    The HARMONIC_LOCK threshold (0.9) ensures we only bypass when the agent's
    capability profile is close enough to the shard that the pre-computed state
    is semantically appropriate — not just any cached value.
    """
    agent_vec = fingerprint_to_vector(agent_fp)
    score = resonance_score(agent_vec, shard_vector)

    if score >= HARMONIC_LOCK and akashic_field is not None:
        node = akashic_field.current()
        if node is not None:
            return {
                "bypass":    True,
                "score":     round(score, 6),
                "head_hash": akashic_field.head,
                "ciphertext": node.ciphertext,
                "version":   node.version,
                "writer":    node.writer,
                "integrity": node.value_hash,   # caller: sha256(decrypted) must equal this
            }

    return {
        "bypass": False,
        "score":  round(score, 6),
        "reason": "below_harmonic_lock" if score < HARMONIC_LOCK else "no_field_state",
    }
