"""OLW — Open Language Wire. The routing protocol for AI agents."""

__version__ = "1.0.0"

import httpx
from typing import Optional, List

LOCAL_INDEX = "http://localhost:3778"

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


def resolve(address: str, index_url: str = LOCAL_INDEX) -> Optional[dict]:
    """Resolve an OLW address to agent details."""
    r = httpx.get(f"{index_url}/resolve", params={"address": address})
    return None if r.status_code == 404 else r.json()


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


__all__ = ["Agent", "resolve", "query", "fingerprint", "__version__"]
