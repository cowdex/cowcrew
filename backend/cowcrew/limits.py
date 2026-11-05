"""Claude plan usage (session and weekly limits), as Claude itself reports it.

Claude doesn't offer an API for the usage page in the Claude apps, but it reports the same
numbers to its own tools, and CowCrew collects them from three official places:
- agent runs: the Agent SDK's rate-limit events (session, weekly and per-model windows);
- Claude Code's status line: after each reply Claude Code passes `rate_limits` (5-hour and
  7-day used percentage and reset time) to the status-line command, which CowCrew can install;
- "Refresh now": a one-line Haiku request that makes Claude report the current values.
Every reading is kept, so CowCrew can also show how much of the week was used each day.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from cowcrew.db import Database
from cowcrew.models import ClaudeUsage, DailyUsage, PlanLimit

KEY = "plan_limits"
LABELS = {
    "five_hour": "Current session",
    "seven_day": "All models",
    "seven_day_opus": "Opus",
    "seven_day_sonnet": "Sonnet",
    "seven_day_fable": "Fable",
    "overage": "Extra usage",
}
ORDER = list(LABELS)


def _now() -> float:
    return datetime.now(UTC).timestamp()


def _epoch(value: Any) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _store(db: Database, kind: str, used_pct: float | None, status: str,
           resets_at: float | None, source: str) -> None:
    now = _now()
    stored = dict(db.get_setting(KEY, {}) or {})
    stored[kind] = {"status": status,
                    "utilization": used_pct / 100 if used_pct is not None else None,
                    "resets_at": resets_at, "seen_at": now, "source": source}
    db.set_setting(KEY, stored)
    if used_pct is not None:
        db.insert("limit_snapshots", ts=now, kind=kind, used_pct=used_pct, resets_at=resets_at,
                  source=source)


def record(db: Database, info: dict[str, Any], source: str = "agent") -> None:
    """One Agent SDK rate-limit event (keys as the CLI sends them: rateLimitType...)."""
    kind = info.get("rateLimitType") or info.get("rate_limit_type")
    if not kind:
        return
    util = info.get("utilization")
    used = float(util) * 100 if util is not None else None
    _store(db, kind, used, info.get("status") or "allowed",
           _epoch(info.get("resetsAt") or info.get("resets_at")), source)


def record_statusline(db: Database, rate_limits: dict[str, Any]) -> int:
    """`rate_limits` from Claude Code's status-line JSON. Returns how many windows were stored."""
    n = 0
    for kind, row in (rate_limits or {}).items():
        if not isinstance(row, dict) or row.get("used_percentage") is None:
            continue
        used = float(row["used_percentage"])
        status = "rejected" if used >= 100 else "allowed_warning" if used >= 80 else "allowed"
        _store(db, kind, used, status, _epoch(row.get("resets_at") or row.get("reset_at")),
               "claude_code")
        n += 1
    return n


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
            label=LABELS.get(kind, kind.replace("_", " ").capitalize()),
            # A window that has reset since we last heard about it starts again from zero.
            used_pct=0.0 if expired else (
                round(100 * row["utilization"], 1) if row.get("utilization") is not None else None),
            status="allowed" if expired else row.get("status", "allowed"),
            resets_at=None if expired else resets_at,
            seen_at=row.get("seen_at") or now,
            source=row.get("source", "agent"),
        ))
    return out


def daily(db: Database, days: int = 7) -> list[DailyUsage]:
    """Share of the weekly limit used on each of the last `days` days (from saved readings)."""
    start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    first = start - timedelta(days=days - 1)
    rows = db.all("SELECT ts, used_pct FROM limit_snapshots WHERE kind = 'seven_day' AND ts >= ? "
                  "ORDER BY ts", ((first - timedelta(days=1)).timestamp(),))
    per_day: dict[str, float] = {}
    prev: float | None = None
    for r in rows:
        day = datetime.fromtimestamp(r["ts"]).astimezone().date().isoformat()
        if prev is not None and r["used_pct"] >= prev:
            per_day[day] = per_day.get(day, 0.0) + (r["used_pct"] - prev)
        prev = r["used_pct"]  # a drop means the week reset: start counting again from there
    out = []
    for i in range(days):
        d = (first + timedelta(days=i)).date().isoformat()
        out.append(DailyUsage(date=d, weekly_pct=round(per_day.get(d, 0.0), 1)))
    return out


def usage(db: Database, statusline_on: bool) -> ClaudeUsage:
    lim = read(db)
    return ClaudeUsage(limits=lim, updated_at=max((x.seen_at for x in lim), default=None),
                       daily=daily(db), statusline_connected=statusline_on)


def simulate(db: Database, session_tokens: int = 4_000_000, week_tokens: int = 40_000_000) -> None:
    """Simulate mode: plausible session/weekly bars from the tokens agents used recently."""
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
                    "resetsAt": int(reset)}, source="simulated")


async def probe(db: Database) -> bool:
    """Ask Claude for fresh numbers with the smallest possible request. True if it reported any."""
    from claude_agent_sdk import ClaudeAgentOptions, RateLimitEvent, query

    async def prompt():  # type: ignore[no-untyped-def]
        yield {"type": "user", "message": {"role": "user", "content": "Reply with: OK"},
               "parent_tool_use_id": None, "session_id": ""}

    got = False  # True only when Claude reported a percentage, not just a status
    options = ClaudeAgentOptions(model="haiku", tools=[], allowed_tools=[], max_turns=1,
                                 setting_sources=[], permission_mode="default")
    async for message in query(prompt=prompt(), options=options):
        if isinstance(message, RateLimitEvent):
            record(db, message.rate_limit_info.raw, source="refresh")
            got = got or message.rate_limit_info.utilization is not None
    return got


# --------------------------------------------------------------------------- status-line bridge

SCRIPT = '''#!/usr/bin/env python3
"""Installed by CowCrew: sends Claude Code plan usage to CowCrew, then runs your old status line."""
import json, pathlib, subprocess, sys, urllib.request
URL = {url!r}
SAVED = pathlib.Path({saved!r})
PREVIOUS = json.loads(SAVED.read_text()).get("command") if SAVED.exists() else None
raw = sys.stdin.read()
try:
    limits = json.loads(raw).get("rate_limits")
    if limits:
        req = urllib.request.Request(URL, data=json.dumps(limits).encode(),
                                     headers={{"content-type": "application/json"}})
        urllib.request.urlopen(req, timeout=0.5)
except Exception:
    pass
if PREVIOUS:
    try:
        out = subprocess.run(PREVIOUS, shell=True, input=raw, capture_output=True, text=True,
                             timeout=5)
        sys.stdout.write(out.stdout)
    except Exception:
        pass
'''


def _claude_settings() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "settings.json"


def _script_path(home: Path) -> Path:
    return home / "claude-statusline.py"


def _saved_path(home: Path) -> Path:
    return home / "claude-statusline-previous.json"


def statusline_installed(home: Path) -> bool:
    path = _claude_settings()
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
    except ValueError:
        return False
    cmd = (data.get("statusLine") or {}).get("command", "")
    return str(_script_path(home)) in cmd


def install_statusline(home: Path, url: str) -> None:
    """Point Claude Code's status line at CowCrew's forwarder, keeping any existing one."""
    path = _claude_settings()
    data: dict[str, Any] = {}
    if path.exists():
        data = json.loads(path.read_text())  # invalid JSON raises: never overwrite blindly
        path.with_name("settings.json.cowcrew-backup").write_text(path.read_text())
    current = data.get("statusLine") or {}
    script = _script_path(home)
    home.mkdir(parents=True, exist_ok=True)
    saved = _saved_path(home)
    if str(script) not in current.get("command", ""):  # remember the user's own status line once
        saved.write_text(json.dumps({"command": current.get("command")}))
    script.write_text(SCRIPT.format(url=url, saved=str(saved)))
    script.chmod(0o755)
    data["statusLine"] = {**current, "type": "command",
                          "command": f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}"}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def uninstall_statusline(home: Path) -> None:
    """Restore the previous status line (or none) and remove the forwarder."""
    path = _claude_settings()
    script = _script_path(home)
    if path.exists():
        data = json.loads(path.read_text())
        if str(script) in (data.get("statusLine") or {}).get("command", ""):
            saved = _saved_path(home)
            previous = json.loads(saved.read_text()).get("command") if saved.exists() else None
            if previous:
                data["statusLine"] = {**data["statusLine"], "command": previous}
            else:
                data.pop("statusLine", None)
            path.write_text(json.dumps(data, indent=2) + "\n")
    script.unlink(missing_ok=True)
    _saved_path(home).unlink(missing_ok=True)
