"""Claude plan usage limits, as Claude itself reports them.

On a Claude Pro/Max/Ultra login, Claude Code tells the Agent SDK how much of each usage window
is used (the same session and weekly bars as in the Claude apps) through rate-limit events.
CowCrew keeps the latest value per window. It is only as fresh as the last agent run.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from cowcrew.db import Database
from cowcrew.models import PlanLimit

KEY = "plan_limits"
LABELS = {
    "five_hour": "Current session (5h)",
    "seven_day": "Weekly · all models",
    "seven_day_opus": "Weekly · Opus",
    "seven_day_sonnet": "Weekly · Sonnet",
    "overage": "Extra usage",
}
ORDER = list(LABELS)


def _now() -> float:
    return datetime.now(UTC).timestamp()


def record(db: Database, info: dict[str, Any]) -> None:
    """Store one rate-limit event (keys as the CLI sends them: rateLimitType, utilization...)."""
    kind = info.get("rateLimitType") or info.get("rate_limit_type")
    if not kind:
        return
    util = info.get("utilization")
    stored = dict(db.get_setting(KEY, {}) or {})
    stored[kind] = {
        "status": info.get("status") or "allowed",
        "utilization": float(util) if util is not None else None,
        "resets_at": info.get("resetsAt") or info.get("resets_at"),
        "seen_at": _now(),
    }
    db.set_setting(KEY, stored)


def read(db: Database) -> list[PlanLimit]:
    stored = db.get_setting(KEY, {}) or {}
    now = _now()
    out: list[PlanLimit] = []
    for kind in sorted(stored, key=lambda k: ORDER.index(k) if k in ORDER else 99):
        row = stored[kind]
        resets_at = row.get("resets_at")
        expired = bool(resets_at) and resets_at < now
        out.append(PlanLimit(
            kind=kind,
            label=LABELS.get(kind, kind.replace("_", " ")),
            # A window that has reset since we last heard about it starts again from zero.
            used_pct=0.0 if expired else (
                round(100 * row["utilization"], 1) if row.get("utilization") is not None else None),
            status="allowed" if expired else row.get("status", "allowed"),
            resets_at=None if expired else resets_at,
            seen_at=row.get("seen_at") or now,
        ))
    return out


def simulate(db: Database, session_tokens: int = 4_000_000, week_tokens: int = 40_000_000) -> None:
    """Simulate mode: plausible session/weekly bars from the tokens agents used recently."""
    from datetime import timedelta

    from cowcrew.db import to_iso

    def used(hours: float) -> float:
        since = to_iso(datetime.now(UTC) - timedelta(hours=hours))
        return float(db.scalar(
            "SELECT COALESCE(SUM(COALESCE(json_extract(data, '$.input_tokens'), 0)"
            " + COALESCE(json_extract(data, '$.output_tokens'), 0)), 0) FROM events "
            "WHERE kind = 'cost' AND ts > ?", (since,)) or 0)

    now = _now()
    for kind, hours, cap, reset in (("five_hour", 5, session_tokens, now + 3 * 3600),
                                    ("seven_day", 168, week_tokens, now + 4 * 86400)):
        util = min(1.0, used(hours) / cap)
        status = "rejected" if util >= 1 else "allowed_warning" if util >= 0.8 else "allowed"
        record(db, {"rateLimitType": kind, "utilization": util, "status": status,
                    "resetsAt": int(reset)})
