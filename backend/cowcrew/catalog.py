"""The Claude models an agent can use, for the Settings dropdowns.

With an API key the list comes live from the Anthropic Models API (cached for an hour). Without
one (a Claude Pro/Max login, Bedrock, Vertex) or when the call fails, a built-in list of the
current models is used. Aliases such as "opus" always point at the latest model of that family.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

from pydantic import BaseModel

MODELS_URL = "https://api.anthropic.com/v1/models?limit=100"
CACHE_SECONDS = 3600


class ModelOption(BaseModel):
    id: str
    name: str
    group: str  # "Latest (alias)" | "Current" | "Older"
    note: str = ""


class ModelCatalog(BaseModel):
    source: str  # "anthropic" (live) | "builtin"
    fetched_at: float
    models: list[ModelOption]


ALIASES: list[ModelOption] = [
    ModelOption(id="fable", name="Fable (latest)", group="Latest (alias)",
                note="Most capable; best for planning and review"),
    ModelOption(id="opus", name="Opus (latest)", group="Latest (alias)",
                note="Strong all-rounder for coding"),
    ModelOption(id="sonnet", name="Sonnet (latest)", group="Latest (alias)",
                note="Fast and cheaper; good for tests and CI logs"),
    ModelOption(id="haiku", name="Haiku (latest)", group="Latest (alias)",
                note="Fastest and cheapest"),
]

# Snapshot of the Claude API lineup (November 2026). Used when the live list isn't reachable.
BUILTIN: list[ModelOption] = [
    ModelOption(id="claude-fable-5-1", name="Claude Fable 5.1", group="Current",
                note="$10 / $50 per MTok"),
    ModelOption(id="claude-opus-5-5", name="Claude Opus 5.5", group="Current",
                note="$4 / $20 per MTok"),
    ModelOption(id="claude-sonnet-5-5", name="Claude Sonnet 5.5", group="Current",
                note="$2 / $10 per MTok"),
    ModelOption(id="claude-haiku-5-5", name="Claude Haiku 5.5", group="Current",
                note="from $0.10 / $0.50 per MTok"),
    ModelOption(id="claude-opus-5", name="Claude Opus 5", group="Older",
                note="legacy"),
    ModelOption(id="claude-sonnet-5", name="Claude Sonnet 5", group="Older",
                note="legacy"),
]

_cache: ModelCatalog | None = None


def _fetch_live(api_key: str) -> list[ModelOption]:
    req = urllib.request.Request(MODELS_URL, headers={
        "x-api-key": api_key, "anthropic-version": "2023-06-01", "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as resp:  # noqa: S310 - fixed https URL
        data = json.load(resp)
    rows = sorted(data.get("data", []), key=lambda m: m.get("created_at", ""), reverse=True)
    current_families: set[str] = set()
    out: list[ModelOption] = []
    for m in rows:
        mid = str(m.get("id", ""))
        if not mid.startswith("claude"):
            continue
        family = next((f for f in ("fable", "mythos", "opus", "sonnet", "haiku") if f in mid), mid)
        group = "Older" if family in current_families else "Current"
        current_families.add(family)
        out.append(ModelOption(id=mid, name=str(m.get("display_name") or mid), group=group))
    return out


def catalog(refresh: bool = False) -> ModelCatalog:
    """Aliases first, then the live list when an API key works, else the built-in snapshot."""
    global _cache
    if _cache and not refresh and time.time() - _cache.fetched_at < CACHE_SECONDS:
        return _cache
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    source, models = "builtin", BUILTIN
    if key:
        try:
            live = _fetch_live(key)
            if live:
                source, models = "anthropic", live
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            pass
    _cache = ModelCatalog(source=source, fetched_at=time.time(), models=[*ALIASES, *models])
    return _cache
