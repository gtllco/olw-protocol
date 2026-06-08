"""Tests for RSB algorithm and FieldCRDT merge."""
import hashlib
from datetime import datetime, timezone

import numpy as np
import pytest

from rsb import (
    HARMONIC_LOCK, RESONANCE_THRESHOLD,
    FieldCRDT, MerkleNode, OLWFingerprint,
    _is_ancestor, _resolve_heads,
    fingerprint_to_vector, resonance_score, rsb_evaluate,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

def make_fp(**overrides) -> OLWFingerprint:
    defaults = dict(
        domain="general", task_types=["summarize"],
        input_formats=["text"], output_formats=["text"],
        context_depth="medium", latency_class="standard",
        trust_level="verified", soul_compatible=True,
    )
    defaults.update(overrides)
    return OLWFingerprint(**defaults)

def ts() -> str:
    return datetime.now(timezone.utc).isoformat()

def vh(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

# ── Fingerprint → vector ──────────────────────────────────────────────────────

def test_vector_is_unit():
    v = fingerprint_to_vector(make_fp())
    assert abs(np.linalg.norm(v) - 1.0) < 1e-9

def test_identical_fingerprints_score_one():
    fp = make_fp()
    v = fingerprint_to_vector(fp)
    assert resonance_score(v, v) == pytest.approx(1.0)

def test_different_fingerprints_below_lock():
    fp_a = make_fp(domain="legal",   context_depth="deep",    trust_level="high",     soul_compatible=True)
    fp_b = make_fp(domain="general", context_depth="shallow", trust_level="open",     soul_compatible=False)
    va, vb = fingerprint_to_vector(fp_a), fingerprint_to_vector(fp_b)
    assert resonance_score(va, vb) < HARMONIC_LOCK

def test_near_identical_fingerprints_above_lock():
    fp_a = make_fp(domain="legal", soul_compatible=True)
    fp_b = make_fp(domain="legal", soul_compatible=True)  # identical
    va, vb = fingerprint_to_vector(fp_a), fingerprint_to_vector(fp_b)
    assert resonance_score(va, vb) >= HARMONIC_LOCK

# ── FieldCRDT basic operations ────────────────────────────────────────────────

def test_write_advances_head():
    crdt = FieldCRDT.new()
    assert crdt.head is None
    h = crdt.write("ct1", vh("v1"), "agent-a@test.olw", ts())
    assert crdt.head == h
    assert crdt.current() is not None
    assert crdt.current().version == 1

def test_write_is_append_only():
    crdt = FieldCRDT.new()
    h1 = crdt.write("ct1", vh("v1"), "agent-a@test.olw", ts())
    h2 = crdt.write("ct2", vh("v2"), "agent-a@test.olw", ts())
    assert h1 != h2
    assert crdt.head == h2
    assert crdt.dag[h2].parent == h1
    assert len(crdt.history()) == 2

def test_node_hash_is_deterministic():
    node = MerkleNode(version=1, value_hash=vh("x"), ciphertext="ct",
                      writer="a@b.olw", timestamp="2026-01-01T00:00:00Z", parent=None)
    h1 = FieldCRDT.node_hash(node)
    h2 = FieldCRDT.node_hash(node)
    assert h1 == h2

def test_is_ancestor():
    crdt = FieldCRDT.new()
    h1 = crdt.write("ct1", vh("v1"), "a@b.olw", ts())
    h2 = crdt.write("ct2", vh("v2"), "a@b.olw", ts())
    assert _is_ancestor(h1, h2, crdt.dag)   # h1 is ancestor of h2
    assert not _is_ancestor(h2, h1, crdt.dag)  # h2 is NOT ancestor of h1

# ── FieldCRDT merge ───────────────────────────────────────────────────────────

def test_merge_linear_history():
    """Merge when one replica has strictly more history — descendant wins."""
    a = FieldCRDT.new()
    h1 = a.write("ct1", vh("v1"), "agent-a@test.olw", ts())

    b = FieldCRDT.from_dict(a.to_dict())   # B is a clone of A at version 1
    h2 = b.write("ct2", vh("v2"), "agent-a@test.olw", ts())  # B advances

    merged = a.merge(b)
    assert merged.head == h2   # B's head wins (it's the descendant)
    assert len(merged.dag) == 2

def test_merge_concurrent_writes_deterministic():
    """Concurrent writes on the same base — tie-break by max hash, consistent."""
    base = FieldCRDT.new()
    base.write("ct0", vh("v0"), "agent-x@test.olw", ts())

    replica_a = FieldCRDT.from_dict(base.to_dict())
    replica_b = FieldCRDT.from_dict(base.to_dict())

    ha = replica_a.write("ct_a", vh("va"), "agent-a@test.olw", ts())
    hb = replica_b.write("ct_b", vh("vb"), "agent-b@test.olw", ts())

    merged_ab = replica_a.merge(replica_b)
    merged_ba = replica_b.merge(replica_a)

    # Both orderings resolve to the same head
    assert merged_ab.head == merged_ba.head
    # The head is whichever hash is lexicographically larger
    assert merged_ab.head == max(ha, hb)

def test_merge_idempotent():
    a = FieldCRDT.new()
    a.write("ct1", vh("v1"), "a@b.olw", ts())
    merged = a.merge(a)
    assert merged.head == a.head
    assert len(merged.dag) == len(a.dag)

def test_merge_commutative():
    a = FieldCRDT.new()
    b = FieldCRDT.new()
    a.write("ct_a", vh("va"), "agent-a@test.olw", ts())
    b.write("ct_b", vh("vb"), "agent-b@test.olw", ts())
    assert a.merge(b).head == b.merge(a).head

def test_merge_associative():
    a, b, c = FieldCRDT.new(), FieldCRDT.new(), FieldCRDT.new()
    a.write("ct_a", vh("va"), "a@test.olw", ts())
    b.write("ct_b", vh("vb"), "b@test.olw", ts())
    c.write("ct_c", vh("vc"), "c@test.olw", ts())
    assert a.merge(b).merge(c).head == a.merge(b.merge(c)).head

def test_merge_no_data_loss():
    """All nodes from both replicas appear in the merged DAG."""
    a = FieldCRDT.new()
    b = FieldCRDT.new()
    ha = a.write("ct_a", vh("va"), "a@test.olw", ts())
    hb = b.write("ct_b", vh("vb"), "b@test.olw", ts())
    merged = a.merge(b)
    assert ha in merged.dag
    assert hb in merged.dag

def test_serialization_roundtrip():
    crdt = FieldCRDT.new()
    crdt.write("ct1", vh("v1"), "a@b.olw", ts())
    crdt.write("ct2", vh("v2"), "a@b.olw", ts())
    restored = FieldCRDT.from_dict(crdt.to_dict())
    assert restored.head == crdt.head
    assert len(restored.dag) == len(crdt.dag)
    assert restored.vector_clock == crdt.vector_clock

# ── RSB decision ──────────────────────────────────────────────────────────────

def test_rsb_bypass_on_harmonic_lock():
    fp = make_fp(domain="legal", context_depth="deep", trust_level="high", soul_compatible=True)
    shard_vec = fingerprint_to_vector(fp)   # identical → score=1.0

    crdt = FieldCRDT.new()
    crdt.write("encrypted_state", vh("plaintext"), "writer@test.olw", ts())

    result = rsb_evaluate(fp, shard_vec, crdt)
    assert result["bypass"] is True
    assert result["score"] >= HARMONIC_LOCK
    assert "ciphertext" in result
    assert "head_hash" in result
    assert "integrity" in result

def test_rsb_no_bypass_below_threshold():
    fp_a = make_fp(domain="legal",   context_depth="deep",    soul_compatible=True)
    fp_b = make_fp(domain="general", context_depth="shallow", soul_compatible=False)
    shard_vec = fingerprint_to_vector(fp_b)

    crdt = FieldCRDT.new()
    crdt.write("ct", vh("val"), "w@test.olw", ts())

    result = rsb_evaluate(fp_a, shard_vec, crdt)
    assert result["bypass"] is False
    assert result["reason"] == "below_harmonic_lock"

def test_rsb_no_bypass_when_no_field():
    fp = make_fp()
    shard_vec = fingerprint_to_vector(fp)
    result = rsb_evaluate(fp, shard_vec, None)
    assert result["bypass"] is False
    assert result["reason"] == "no_field_state"

def test_rsb_no_bypass_on_empty_crdt():
    fp = make_fp()
    shard_vec = fingerprint_to_vector(fp)
    result = rsb_evaluate(fp, shard_vec, FieldCRDT.new())
    assert result["bypass"] is False

def test_rsb_integrity_field_matches_ciphertext():
    fp = make_fp()
    shard_vec = fingerprint_to_vector(fp)
    crdt = FieldCRDT.new()
    plaintext = "The trip is confirmed."
    crdt.write("sealed_box_of_plaintext", vh(plaintext), "w@test.olw", ts())
    result = rsb_evaluate(fp, shard_vec, crdt)
    assert result["integrity"] == vh(plaintext)
