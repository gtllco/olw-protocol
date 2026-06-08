"""OLW — Open Language Wire. The routing protocol for AI agents."""

__version__ = "1.2.0"

import httpx
import json
from typing import Optional, List

LOCAL_INDEX = "http://localhost:3778"

# Mapping from .olw owner-domain roots to real host TLDs used when
# constructing the .well-known fallback URL.  Add entries here as new
# OLW domains are deployed.
OLW_DOMAIN_MAP: dict = {
    "gtll": "777.gtll.app",
    "777": "777.gtll.app",
}

# Public OLW index (used when resolving from outside the local network).
PUBLIC_INDEX = "https://olw.gtll.app"


class Agent:
    def __init__(self, address: str, name: str, description: str, endpoint: str,
                 fingerprint: dict, well_known_url: Optional[str] = None):
        self.address = address
        self.name = name
        self.description = description
        self.endpoint = endpoint
        self.fingerprint = fingerprint
        self.well_known_url = well_known_url

    def register(self, index_url: str = LOCAL_INDEX) -> dict:
        r = httpx.post(f"{index_url}/register", json={
            "address": self.address, "name": self.name,
            "description": self.description, "endpoint": self.endpoint,
            "fingerprint": self.fingerprint, "well_known_url": self.well_known_url,
        })
        return r.json()

    def to_dict(self) -> dict:
        return {"olw_version": "0.1", "address": self.address, "name": self.name,
                "description": self.description, "endpoint": self.endpoint,
                "fingerprint": self.fingerprint}


def _well_known_url_for(address: str) -> Optional[str]:
    """
    Derive the .well-known crawl URL from an OLW address.

    Protocol convention:
      soul-guide@gtll.olw  ->  https://gtll.app/.well-known/olw/agent.json
      soul-guide@777.olw   ->  https://777.gtll.app/.well-known/olw/agent.json

    For domains not in OLW_DOMAIN_MAP, the owner-domain is used as-is
    (i.e. the .olw suffix is treated as a real TLD -- useful for future
    real-TLD registrations).
    """
    if "@" not in address:
        return None
    owner_domain = address.split("@", 1)[1]  # e.g. "gtll.olw"
    if owner_domain.endswith(".olw"):
        root = owner_domain[:-4]  # strip ".olw"
        host = OLW_DOMAIN_MAP.get(root, f"{root}.olw")
    else:
        host = owner_domain
    return f"https://{host}/.well-known/olw/agent.json"


def _crawl_well_known(address: str) -> Optional[dict]:
    """
    Fetch and validate an agent record from its .well-known endpoint.
    Returns the parsed JSON dict on success, None if the URL is unreachable or 404s.
    Raises ValueError if the JSON is present but malformed/mismatched.
    """
    url = _well_known_url_for(address)
    if url is None:
        return None
    try:
        r = httpx.get(url, follow_redirects=True, timeout=10)
    except (httpx.TransportError, httpx.ConnectError):
        # DNS failure or connection refused -- the .well-known host doesn't exist.
        return None
    if r.status_code == 404:
        return None
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict) or "address" not in data or "endpoint" not in data:
        raise ValueError(f"Invalid agent.json at {url}: missing required fields")
    if data.get("address") != address:
        raise ValueError(
            f"Address mismatch in agent.json at {url}: "
            f"expected '{address}', got '{data.get('address')}'"
        )
    return data


def resolve(address: str, index_url: str = LOCAL_INDEX,
            well_known_fallback: bool = True) -> Optional[dict]:
    """
    Resolve an OLW address to agent details.

    Resolution order (Phase 3 -- decentralized):
      1. Query the index server.
      2. If the index returns 404 AND well_known_fallback is True,
         crawl the agent's .well-known/olw/agent.json endpoint directly.
      3. If .well-known also returns 404, return None.

    Raises ValueError if agent.json is found but fails validation.
    Raises httpx.HTTPError on unrecoverable network errors.
    """
    try:
        r = httpx.get(f"{index_url}/resolve", params={"address": address}, timeout=10)
    except httpx.HTTPError:
        # Index unreachable -- fall through to .well-known if enabled.
        r = None

    if r is not None and r.status_code != 404:
        return r.json()

    # Index miss (404) or unreachable -> try .well-known crawl.
    if well_known_fallback:
        data = _crawl_well_known(address)
        if data is not None:
            return data

    return None


def query(index_url: str = LOCAL_INDEX, **axes) -> List[dict]:
    """Find agents by capability axes. Example: olw.query(soul_compatible=True, domain='legal')"""
    params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in axes.items()}
    r = httpx.get(f"{index_url}/query", params=params)
    return r.json().get("agents", [])


def fingerprint(domain: str, task_types: list, input_formats: list, output_formats: list,
                context_depth: str = "medium", latency_class: str = "standard",
                trust_level: str = "authenticated", soul_compatible: bool = False) -> dict:
    """Build a valid OLW capability fingerprint."""
    return {"domain": domain, "task_types": task_types,
            "input_formats": input_formats, "output_formats": output_formats,
            "context_depth": context_depth, "latency_class": latency_class,
            "trust_level": trust_level, "soul_compatible": soul_compatible}



# ── Akashic Layer (Element 3) ─────────────────────────────────────────────────

def akashic_keygen(index_url: str = PUBLIC_INDEX) -> dict:
    """Generate a fresh X25519 + Ed25519 keypair. Store private keys securely."""
    r = httpx.post(f"{index_url}/akashic/keygen", timeout=10)
    r.raise_for_status()
    return r.json()


def akashic_register_keys(address: str, x25519_pub: str, ed25519_pub: str,
                           index_url: str = PUBLIC_INDEX) -> dict:
    """Register public keys for an OLW address. Required before writing fields or creating grants."""
    r = httpx.post(f"{index_url}/akashic/keys", timeout=10, json={
        "address": address, "x25519_pub": x25519_pub, "ed25519_pub": ed25519_pub,
    })
    r.raise_for_status()
    return r.json()


def akashic_write(writer: str, ed25519_priv: str, namespace: str, field_path: str,
                  value: str, recipient: str = None, propagation: str = "local",
                  ttl: int = None, index_url: str = PUBLIC_INDEX) -> dict:
    """Encrypt value as a sealed box and write it as an Akashic field."""
    recipient = recipient or namespace
    # Fetch recipient public key
    keys_r = httpx.get(f"{index_url}/akashic/keys", params={"address": recipient}, timeout=10)
    keys_r.raise_for_status()
    keys_data = keys_r.json()
    if not keys_data.get("ok"):
        raise ValueError(f"no public keys registered for {recipient}")
    # Seal the value server-side (convenience endpoint)
    seal_r = httpx.post(f"{index_url}/akashic/seal", timeout=10, json={
        "plaintext": value, "recipient_address": recipient,
    })
    seal_r.raise_for_status()
    seal_data = seal_r.json()
    ciphertext = seal_data["ciphertext"]
    # Determine version
    version = 1
    try:
        read_r = httpx.post(f"{index_url}/akashic/read", timeout=10, json={
            "requester": writer, "namespace": namespace, "field_paths": [field_path],
        })
        fields = read_r.json().get("fields", [])
        if fields:
            version = fields[0]["version"] + 1
    except Exception:
        pass
    # Sign write payload
    payload = f"{namespace}|{field_path}|{ciphertext}|{version}".encode()
    sig = _ed25519_sign(payload, ed25519_priv)
    body = {"writer": writer, "namespace": namespace, "field_path": field_path,
            "ciphertext": ciphertext, "signature": sig, "propagation": propagation}
    if ttl is not None:
        body["ttl"] = ttl
    r = httpx.post(f"{index_url}/akashic/write", timeout=10, json=body)
    r.raise_for_status()
    return r.json()


def akashic_read(requester: str, namespace: str = None, field_paths: List[str] = None,
                 x25519_priv: str = None, index_url: str = PUBLIC_INDEX) -> List[dict]:
    """Read Akashic fields. Pass x25519_priv to auto-decrypt via server-side /open."""
    body = {"requester": requester}
    if namespace:
        body["namespace"] = namespace
    if field_paths:
        body["field_paths"] = field_paths
    r = httpx.post(f"{index_url}/akashic/read", timeout=10, json=body)
    r.raise_for_status()
    data = r.json()
    fields = data.get("fields", [])
    if x25519_priv and fields:
        for f in fields:
            try:
                open_r = httpx.post(f"{index_url}/akashic/open", timeout=10, json={
                    "ciphertext": f["ciphertext"], "x25519_priv": x25519_priv,
                })
                open_data = open_r.json()
                if open_data.get("ok"):
                    f["plaintext"] = open_data["plaintext"]
                    del f["ciphertext"]
            except Exception:
                pass
    return fields


def akashic_grant(grantor: str, ed25519_priv: str, grantee: str, fields: List[str],
                  permissions: List[str], expires_at: str,
                  index_url: str = PUBLIC_INDEX) -> dict:
    """Create a signed consent grant allowing another agent access to your fields."""
    grant_body = {"grantor": grantor, "grantee": grantee, "fields": fields,
                  "permissions": permissions, "expires_at": expires_at}
    canonical = json.dumps({k: grant_body[k] for k in
                            ["grantor", "grantee", "fields", "permissions", "expires_at"]
                            if k in grant_body}).encode()
    signature = _ed25519_sign(canonical, ed25519_priv)
    r = httpx.post(f"{index_url}/akashic/grant", timeout=10,
                   json={"grant": grant_body, "signature": signature})
    r.raise_for_status()
    return r.json()


def akashic_revoke(grant_id: str, revoker_address: str, ed25519_priv: str,
                   index_url: str = PUBLIC_INDEX) -> dict:
    """Instantly revoke a consent grant."""
    revocation_signature = _ed25519_sign(grant_id.encode(), ed25519_priv)
    r = httpx.request("DELETE", f"{index_url}/akashic/grant", timeout=10, json={
        "grant_id": grant_id, "revoker_address": revoker_address,
        "revocation_signature": revocation_signature,
    })
    r.raise_for_status()
    return r.json()


def akashic_audit(address: str, limit: int = 50, index_url: str = PUBLIC_INDEX) -> List[dict]:
    """Read the append-only audit log for an OLW address."""
    r = httpx.get(f"{index_url}/akashic/audit",
                  params={"address": address, "limit": limit}, timeout=10)
    r.raise_for_status()
    return r.json().get("log", [])


def akashic_stats(index_url: str = PUBLIC_INDEX) -> dict:
    """Get public Akashic Layer statistics."""
    r = httpx.get(f"{index_url}/akashic/stats", timeout=10)
    r.raise_for_status()
    return r.json()


def _ed25519_sign(data: bytes, priv_key_b64: str) -> str:
    """Sign bytes with an Ed25519 private key (PKCS8 DER base64url). Returns base64url sig."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        import base64
        der = base64.urlsafe_b64decode(priv_key_b64 + "==")
        key = Ed25519PrivateKey.from_private_bytes(der[-32:])
        sig = key.sign(data)
        return base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    except ImportError:
        raise RuntimeError(
            "Ed25519 signing requires 'cryptography': pip install cryptography"
        )


__all__ = [
    "Agent", "resolve", "query", "fingerprint",
    "akashic_keygen", "akashic_register_keys", "akashic_write", "akashic_read",
    "akashic_grant", "akashic_revoke", "akashic_audit", "akashic_stats",
    "OLW_DOMAIN_MAP", "PUBLIC_INDEX", "__version__",
]
