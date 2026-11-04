"""Dashboard computations: KPIs, board, spend, trends, agent cards and activity."""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from cowcrew.agents.runner import ActiveRun
from cowcrew.db import Database, parse_iso, to_iso
from cowcrew.events import row_to_event
from cowcrew.models import (
    AGENT_NAMES,
    AGENT_SHORT,
    TERMINAL_STATES,
    WORKER_AGENTS,
    AgentCard,
    BoardRow,
    Kpis,
    ModelSpend,
    Overview,
    Spend,
    StageState,
    Trend,
)
from cowcrew.store import STAGE_OF, effective_status, latest_ci_status, summary_of, tasks_of

MEANINGFUL = ("status", "handoff", "verdict", "gate", "error")
TREND_DAYS = 12


def _ago(days: float) -> str:
    return to_iso(datetime.now(UTC) - timedelta(days=days))


def spend_since_days(db: Database, days: float, until_days: float = 0) -> float:
    """Sum of cost events in the window (now - days, now - until_days]."""
    return float(db.scalar(
        "SELECT COALESCE(SUM(json_extract(data, '$.cost_usd')), 0) FROM events "
        "WHERE kind = 'cost' AND ts > ? AND ts <= ?", (_ago(days), _ago(until_days))) or 0.0)


def _project_filter(project_id: int | None, alias: str = "f") -> tuple[str, tuple[int, ...]]:
    if project_id is None:
        return "", ()
    return f" AND {alias}.project_id = ?", (project_id,)


def _kpis(db: Database, rows: list[sqlite3.Row], budget: float, spend_7d: float,
          pf: tuple[str, tuple[int, ...]]) -> Kpis:
    committed = db.all(
        "SELECT t.attempts FROM tasks t JOIN features f ON f.id = t.feature_id "
        f"WHERE t.status = 'committed' AND t.committed_at > ?{pf[0]}", (_ago(7), *pf[1]))
    first = sum(1 for r in committed if r["attempts"] <= 1)
    active = [r for r in rows if r["status"] not in TERMINAL_STATES]
    return Kpis(
        in_flight=len(active),
        waiting_on_you=sum(r["status"] in {"awaiting_answers", "awaiting_plan_approval",
                                           "awaiting_merge"} for r in active),
        committed_7d=len(committed),
        first_try_pass_pct=round(100 * first / len(committed), 1) if committed else 0.0,
        first_try_pass_num=first,
        ci_failing=sum(effective_status(r) == "ci" and latest_ci_status(db, r["id"]) == "failure"
                       for r in active),
        spend_7d_usd=round(spend_7d, 2),
        budget_usd=budget,
    )


def _board(db: Database, rows: list[sqlite3.Row]) -> list[BoardRow]:
    board = []
    for row in rows:
        if row["status"] in TERMINAL_STATES:
            continue
        tasks = tasks_of(db, row["id"])
        if STAGE_OF[effective_status(row)] == "plan":
            cells: list[StageState] = ["wait"] * max(1, len(tasks))
        else:
            mapping: dict[str, StageState] = {"committed": "done", "running": "run",
                                              "testing": "run", "failed": "fail",
                                              "pending": "pend"}
            cells = [mapping[t.status] for t in tasks] or ["pend"]
        board.append(BoardRow(feature_id=row["id"], title=row["title"], cells=cells,
                              summary=summary_of(db, row).stage_text))
    return board


def _spend(db: Database, spend_7d: float, budget: float) -> Spend:
    prev = spend_since_days(db, 14, 7)
    rows = db.all(
        "SELECT json_extract(data, '$.model') AS model, agent, "
        "SUM(json_extract(data, '$.cost_usd')) AS usd FROM events "
        "WHERE kind = 'cost' AND ts > ? GROUP BY model, agent", (_ago(7),))
    by_model: dict[str, float] = defaultdict(float)
    agents: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        model = r["model"] or "unknown"
        by_model[model] += r["usd"] or 0.0
        name = AGENT_SHORT.get(r["agent"], r["agent"])
        if name not in agents[model]:
            agents[model].append(name)
    first_ts = db.scalar("SELECT MIN(ts) FROM events WHERE kind = 'cost' AND ts > ?", (_ago(7),))
    covered = 7.0
    if first_ts:
        covered = min(7.0, max(1.0, (datetime.now(UTC) - parse_iso(first_ts)).total_seconds()
                               / 86400))
    return Spend(
        total_usd=round(spend_7d, 2),
        wow_pct=round(100 * (spend_7d - prev) / prev, 1) if prev > 0 else None,
        by_model=[
            ModelSpend(model=m, agents=", ".join(agents[m]), usd=round(usd, 2),
                       pct=round(100 * usd / spend_7d, 1) if spend_7d else 0.0)
            for m, usd in sorted(by_model.items(), key=lambda kv: -kv[1])
        ],
        projected_usd=round(spend_7d * 7 / covered, 2),
        budget_used_pct=round(100 * spend_7d / budget, 1) if budget else 0.0,
    )


def _daily(samples: list[tuple[datetime, float]], now: datetime) -> list[float]:
    """Mean per day over the last TREND_DAYS days, carrying the last value over empty days."""
    buckets: list[list[float]] = [[] for _ in range(TREND_DAYS)]
    start = (now - timedelta(days=TREND_DAYS - 1)).date()
    for ts, value in samples:
        idx = (ts.date() - start).days
        if 0 <= idx < TREND_DAYS:
            buckets[idx].append(value)
    out: list[float] = []
    last = next((sum(b) / len(b) for b in buckets if b), 0.0)
    for bucket in buckets:
        last = sum(bucket) / len(bucket) if bucket else last
        out.append(last)
    return out


def _window_mean(samples: list[tuple[datetime, float]], lo: float, hi: float,
                 now: datetime) -> float | None:
    vals = [v for ts, v in samples if now - timedelta(days=hi) < ts <= now - timedelta(days=lo)]
    return sum(vals) / len(vals) if vals else None


def _trend(key: str, label: str, samples: list[tuple[datetime, float]],
           fmt: Callable[[float], str], now: datetime) -> Trend:
    points = _daily(samples, now)
    top = max(points) if points else 0.0
    current = _window_mean(samples, 0, 7, now)
    previous = _window_mean(samples, 7, 14, now)
    if current is None:
        value, delta, good = "—", "no data", True
    elif previous in (None, 0):
        value, delta, good = fmt(current), "new this week", True
    else:
        assert previous is not None
        change = 100 * (current - previous) / previous
        value, good = fmt(current), change <= 0
        delta = f"{'−' if change < 0 else '+'}{abs(change):.0f}% vs last week"
    return Trend(key=key, label=label, value=value, delta=delta, good=good,  # type: ignore[arg-type]
                 points=[round(p / top, 3) if top else 0.0 for p in points])


def _fmt_hours(hours: float) -> str:
    return f"{hours * 60:.0f}m" if hours < 1 else f"{hours:.1f}h"


def _trends(db: Database, pf: tuple[str, tuple[int, ...]]) -> list[Trend]:
    now = datetime.now(UTC)
    since = _ago(14 + TREND_DAYS)
    ready = db.all(f"SELECT f.id, f.created_at, f.ready_at FROM features f WHERE "
                   f"f.ready_at IS NOT NULL AND f.ready_at > ?{pf[0]}", (since, *pf[1]))
    lead = [(parse_iso(r["ready_at"]), (parse_iso(r["ready_at"]) - parse_iso(r["created_at"]))
             .total_seconds() / 3600) for r in ready]
    loops = [(parse_iso(r["committed_at"]), float(r["attempts"])) for r in db.all(
        "SELECT t.committed_at, t.attempts FROM tasks t JOIN features f ON f.id = t.feature_id "
        f"WHERE t.status = 'committed' AND t.committed_at > ?{pf[0]}", (since, *pf[1]))]
    blockers = [(parse_iso(r["ready_at"]), float(db.scalar(
        "SELECT COUNT(*) FROM findings WHERE feature_id = ? AND severity = 'Blocker'",
        (r["id"],)))) for r in ready]
    return [
        _trend("lead_time", "Lead time · spec → ready to merge", lead, _fmt_hours, now),
        _trend("loops_per_task", "SWE ⇄ Tester loops per task", loops, lambda v: f"{v:.1f}", now),
        _trend("blockers_per_pr", "Blockers per PR", blockers, lambda v: f"{v:.1f}", now),
    ]


def _agents(db: Database, rows: list[sqlite3.Row], models: dict[str, str],
            active: list[ActiveRun], context: dict[str, float]) -> list[AgentCard]:
    spend = {r["agent"]: r["usd"] or 0.0 for r in db.all(
        "SELECT agent, SUM(json_extract(data, '$.cost_usd')) AS usd FROM events "
        "WHERE kind = 'cost' AND ts > ? GROUP BY agent", (_ago(7),))}
    live = [r for r in rows if r["status"] not in TERMINAL_STATES and r["status"] != "paused"]
    cards = []
    for agent in WORKER_AGENTS:
        run = next((r for r in active if r.agent == agent), None)
        if run is not None:
            state, job, feature_id, ctx = "working", run.job, run.feature_id, run.context_pct
        else:
            state, job, feature_id = _derived_state(db, agent, live)
            ctx = context.get(agent) or _last_context(db, agent)
        if not job:
            last = db.one("SELECT message, feature_id FROM events WHERE agent = ? AND kind IN "
                          "('status','handoff','verdict','log') ORDER BY id DESC LIMIT 1",
                          (agent,))
            job = last["message"] if last else "Idle"
            feature_id = feature_id or (last["feature_id"] if last else None)
        cards.append(AgentCard(
            key=agent, name=AGENT_NAMES[agent], model=models.get(agent, "sonnet"),
            state=state, job=job[:140], context_pct=round(ctx, 1),  # type: ignore[arg-type]
            spend_usd=round(spend.get(agent, 0.0), 2), feature_id=feature_id))
    return cards


def _last_context(db: Database, agent: str) -> float:
    value = db.scalar("SELECT json_extract(data, '$.context_pct') FROM events WHERE agent = ? "
                      "AND kind = 'cost' ORDER BY id DESC LIMIT 1", (agent,))
    return float(value or 0.0)


def _derived_state(db: Database, agent: str,
                   live: list[sqlite3.Row]) -> tuple[str, str, int | None]:
    """Agent state implied by feature statuses (covers runs not owned by this process)."""
    for row in live:
        status, title = row["status"], row["title"]
        if agent == "product_architect":
            if status == "awaiting_answers":
                return "waiting", f"Waiting for your answers on {title}", row["id"]
            if status == "awaiting_plan_approval":
                return "waiting", f"Waiting for plan approval on {title}", row["id"]
            if status in {"grilling", "grooming", "accepting"}:
                verb = {"grilling": "Grilling", "grooming": "Grooming",
                        "accepting": "Acceptance review of"}[status]
                return "working", f"{verb} {title}", row["id"]
        if agent in {"software_engineer", "tester"} and status == "building":
            task = next((t for t in tasks_of(db, row["id"]) if t.id == row["current_task_id"]),
                        None)
            if task is not None:
                mine = (task.status == "running") == (agent == "software_engineer")
                return ("working" if mine else "queued",
                        f"Task {task.seq:03d}: {task.title}", row["id"])
        if agent == "pr_reviewer":
            if status == "reviewing":
                return "working", f"Reviewing {title}", row["id"]
            if status == "awaiting_merge":
                return "waiting", f"Ready to merge: {title}", row["id"]
        if agent == "oncall_engineer" and status == "ci":
            if latest_ci_status(db, row["id"]) == "failure":
                return "working", f"Diagnosing red CI on {title}", row["id"]
            return "queued", f"Watching CI for {title}", row["id"]
    return "idle", "", None


def build_overview(
    db: Database, project_id: int | None, budget: float, models: dict[str, str],
    active: list[ActiveRun], context: dict[str, float],
) -> Overview:
    pf = _project_filter(project_id)
    rows = db.all(f"SELECT f.* FROM features f WHERE 1 = 1{pf[0]} ORDER BY f.id DESC", pf[1])
    spend_7d = spend_since_days(db, 7)
    activity = db.all(
        "SELECT e.* FROM events e LEFT JOIN features f ON f.id = e.feature_id "
        f"WHERE e.kind IN ({','.join('?' * len(MEANINGFUL))}){pf[0]} "
        "ORDER BY e.ts DESC, e.id DESC LIMIT 8", (*MEANINGFUL, *pf[1]))
    return Overview(
        kpis=_kpis(db, rows, budget, spend_7d, pf),
        board=_board(db, rows),
        spend=_spend(db, spend_7d, budget),
        trends=_trends(db, pf),
        features=[summary_of(db, r) for r in rows],
        agents=_agents(db, rows, models, active, context),
        activity=[row_to_event(r) for r in activity],
    )
