"""OLW — Open Language Wire. The routing protocol for AI agents."""

__version__ = "1.1.0"

import httpx
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


__all__ = ["Agent", "resolve", "query", "fingerprint",
           "OLW_DOMAIN_MAP", "PUBLIC_INDEX", "__version__"]
