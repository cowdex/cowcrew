"""Read side: turn database rows into contract models (summaries, details, checklist)."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime

from cowcrew.db import Database, loads, parse_iso
from cowcrew.models import (
    GATE_STATES,
    Acceptance,
    Adr,
    ChecklistItem,
    CIRun,
    DiffStats,
    Estimate,
    FeatureDetail,
    FeatureFull,
    FeatureSummary,
    Finding,
    Project,
    Question,
    SpendByAgent,
    StageState,
    Task,
)

STAGES = ("plan", "build", "verify", "ci", "merge")
STAGE_OF: dict[str, str] = {
    "grilling": "plan", "awaiting_answers": "plan", "grooming": "plan",
    "awaiting_plan_approval": "plan", "building": "build", "accepting": "verify",
    "reviewing": "verify", "ci": "ci", "awaiting_merge": "merge", "merged": "merge",
}


def project_of(row: sqlite3.Row) -> Project:
    return Project(**{k: row[k] for k in Project.model_fields})


def effective_status(row: sqlite3.Row) -> str:
    """The pipeline status a paused/stopped/failed feature was in."""
    if row["status"] in STAGE_OF:
        return row["status"]
    return row["resume_status"] or "grilling"


def tasks_of(db: Database, feature_id: int) -> list[Task]:
    rows = db.all("SELECT * FROM tasks WHERE feature_id = ? ORDER BY seq", (feature_id,))
    return [
        Task(
            id=r["id"], seq=r["seq"], title=r["title"], description=r["description"],
            acceptance_criteria=loads(r["acceptance_criteria"], []), depends_on=r["depends_on"],
            label=r["label"], status=r["status"], attempts=r["attempts"],
            commit_sha=r["commit_sha"], kind=r["kind"],
        )
        for r in rows
    ]


def latest_ci_status(db: Database, feature_id: int) -> str | None:
    return db.scalar(
        "SELECT status FROM ci_runs WHERE feature_id = ? ORDER BY id DESC LIMIT 1", (feature_id,)
    )


def _stage_text(db: Database, row: sqlite3.Row, status: str, tasks: list[Task]) -> str:
    fid = row["id"]
    if status == "grilling":
        return "Plan · PA grilling the spec"
    if status == "awaiting_answers":
        n = db.scalar("SELECT COUNT(*) FROM questions WHERE feature_id = ? AND answer IS NULL",
                      (fid,))
        return f"Plan · {n} question{'s' if n != 1 else ''} waiting for you"
    if status == "grooming":
        return "Plan · PA grooming the plan"
    if status == "awaiting_plan_approval":
        return f"Plan · {len(tasks)} tasks ready for approval"
    if status == "building":
        current = next((i for i, t in enumerate(tasks) if t.id == row["current_task_id"]), None)
        if current is None:
            current = next((i for i, t in enumerate(tasks) if t.status != "committed"), 0)
        return f"Build · task {current + 1} of {len(tasks)} · SWE ⇄ Tester"
    if status == "accepting":
        return "Verify · PA acceptance review"
    if status == "reviewing":
        return f"Verify · PR review round {max(1, row['review_round'])}"
    if status == "ci":
        if latest_ci_status(db, fid) == "failure":
            return "CI · red run · On-Call diagnosing"
        return "CI · watching checks"
    if status == "awaiting_merge":
        pr = f" · PR #{row['pr_number']}" if row["pr_number"] else ""
        return f"Merge · ready for your review{pr}"
    sha = row["merged_commit"]
    return f"Merged · {sha[:7]}" if sha else "Merged"


def summary_of(db: Database, row: sqlite3.Row) -> FeatureSummary:
    tasks = tasks_of(db, row["id"])
    status = row["status"]
    eff = effective_status(row)
    idx = STAGES.index(STAGE_OF[eff])
    if status == "merged":
        current: StageState = "done"
    elif status in GATE_STATES or status == "paused":
        current = "wait"
    elif status in {"failed", "stopped"} or (
        status == "ci" and latest_ci_status(db, row["id"]) == "failure"
    ):
        current = "fail"
    else:
        current = "run"
    stages: list[StageState] = [
        "done" if i < idx else current if i == idx else "pend" for i in range(len(STAGES))
    ]
    if status == "merged":
        stages = ["done"] * len(STAGES)
    text = _stage_text(db, row, eff, tasks)
    if status == "paused":
        text = f"Paused · {text}"
    elif status == "stopped":
        text = "Stopped"
    elif status == "failed":
        text = "Failed"
    end = parse_iso(row["finished_at"]) if row["finished_at"] else datetime.now(UTC)
    return FeatureSummary(
        id=row["id"], project_id=row["project_id"], title=row["title"], status=status,
        stage=STAGE_OF[eff], stages=stages, stage_text=text, branch=row["branch"],  # type: ignore[arg-type]
        pr_number=row["pr_number"], pr_url=row["pr_url"],
        tasks_done=sum(t.status == "committed" for t in tasks), tasks_total=len(tasks),
        elapsed_seconds=max(0, int((end - parse_iso(row["created_at"])).total_seconds())),
        cost_usd=round(row["cost_usd"], 4),
        tokens=int(row["tokens_in"] or 0) + int(row["tokens_out"] or 0),
        waiting_on_you=status in GATE_STATES,
        created_at=row["created_at"], updated_at=row["updated_at"],
    )


def summary_by_id(db: Database, feature_id: int) -> FeatureSummary | None:
    row = db.one("SELECT * FROM features WHERE id = ?", (feature_id,))
    return summary_of(db, row) if row else None


def findings_of(db: Database, feature_id: int) -> list[Finding]:
    rows = db.all("SELECT * FROM findings WHERE feature_id = ? ORDER BY round, id", (feature_id,))
    return [Finding(**{k: r[k] for k in Finding.model_fields}) for r in rows]


def acceptance_of(db: Database, feature_id: int) -> Acceptance | None:
    r = db.one("SELECT * FROM acceptances WHERE feature_id = ? ORDER BY id DESC LIMIT 1",
               (feature_id,))
    if r is None:
        return None
    return Acceptance(verdict=r["verdict"], summary=r["summary"],
                      criteria=loads(r["criteria"], []), issues=loads(r["issues"], []))


def ci_runs_of(db: Database, feature_id: int) -> list[CIRun]:
    rows = db.all("SELECT * FROM ci_runs WHERE feature_id = ? ORDER BY id", (feature_id,))
    return [
        CIRun(id=r["id"], run_id=r["run_id"], status=r["status"], jobs=loads(r["jobs"], []),
              failing_job=r["failing_job"], failing_log=r["failing_log"],
              diagnosis=loads(r["diagnosis"]), created_at=r["created_at"])
        for r in rows
    ]


def _spend_by_agent(db: Database, feature_id: int) -> list[SpendByAgent]:
    rows = db.all(
        "SELECT agent, json_extract(data, '$.model') AS model, "
        "SUM(json_extract(data, '$.cost_usd')) AS usd, "
        "SUM(COALESCE(json_extract(data, '$.input_tokens'), 0)"
        " + COALESCE(json_extract(data, '$.output_tokens'), 0)) AS tokens FROM events "
        "WHERE feature_id = ? AND kind = 'cost' GROUP BY agent, model ORDER BY usd DESC",
        (feature_id,),
    )
    return [SpendByAgent(agent=r["agent"], model=r["model"] or "unknown",
                         cost_usd=round(r["usd"] or 0.0, 4), tokens=int(r["tokens"] or 0))
            for r in rows]


def _checklist(
    db: Database, row: sqlite3.Row, tasks: list[Task], acceptance: Acceptance | None,
    findings: list[Finding], ci_runs: list[CIRun], adr: Adr | None,
) -> list[ChecklistItem]:
    committed = [t for t in tasks if t.status == "committed"]
    blockers = [f for f in findings if f.severity == "Blocker"]
    open_blockers = [f for f in blockers if f.status == "open"]
    nits = [f for f in findings if f.severity == "Nit"]
    passed = {
        r["task_id"] for r in db.all(
            "SELECT task_id FROM events WHERE feature_id = ? AND agent = 'tester' "
            "AND kind = 'verdict' AND json_extract(data, '$.verdict') = 'PASS'", (row["id"],))
    }
    duties_ok = bool(committed) and all(t.id in passed for t in committed)
    last_ci = ci_runs[-1] if ci_runs else None
    adr_note = f" · {adr.title}" if adr else ""
    if last_ci is None:
        ci_item = ChecklistItem(
            title="No CI configured" if not row["ci_enabled"] else "CI green",
            sub="No GitHub workflows ran for this branch" if not row["ci_enabled"]
            else "Waiting for checks", ok=not row["ci_enabled"], link="ci")
    else:
        ci_item = ChecklistItem(
            title="CI green", ok=last_ci.status == "success",
            sub=f"{len(ci_runs)} run{'s' if len(ci_runs) != 1 else ''} · latest {last_ci.status}",
            link="ci")
    return [
        ChecklistItem(title="Plan approved", ok=bool(row["approved_at"]),
                      sub=f"{sum(t.kind == 'plan' for t in tasks)} tasks{adr_note}", link="plan"),
        ChecklistItem(title="All tasks committed", ok=bool(tasks) and len(committed) == len(tasks),
                      sub=f"{len(committed)}/{len(tasks)} committed", link="live"),
        ChecklistItem(
            title="PA accepted", ok=acceptance is not None and acceptance.verdict == "ACCEPT",
            sub=(f"{sum(c.met for c in acceptance.criteria)}/{len(acceptance.criteria)} "
                 "criteria met") if acceptance else "Not reviewed yet", link="review"),
        ChecklistItem(
            title="0 open blockers", ok=not open_blockers,
            sub=f"{len(blockers) - len(open_blockers)} fixed · {len(nits)} nits noted",
            link="review"),
        ci_item,
        ChecklistItem(title="Separation of duties", ok=duties_ok,
                      sub="SWE wrote · Tester verified · orchestrator committed", link="live"),
        ChecklistItem(title="Protected checks untouched", ok=not row["protected_touched"],
                      sub="No changes under .github/ or CI config" if not row["protected_touched"]
                      else "Diff touches .github/ or CI config", link="merge"),
    ]


def detail_of(db: Database, row: sqlite3.Row) -> FeatureDetail:
    fid = row["id"]
    summary = summary_of(db, row)
    tasks = tasks_of(db, fid)
    adr_raw = loads(row["adr"])
    adr = Adr(**adr_raw) if adr_raw else None
    est = loads(row["estimate"])
    diff = loads(row["diff_stats"])
    feature = FeatureFull(
        **summary.model_dump(), spec=row["spec"], worktree_path=row["worktree_path"],
        current_task_id=row["current_task_id"], adr=adr,
        glossary_terms=loads(row["glossary_terms"], []),
        estimate=Estimate(**est) if est else None, tokens_in=row["tokens_in"],
        tokens_out=row["tokens_out"], tool_calls=row["tool_calls"],
        diff_stats=DiffStats(**diff) if diff else None, merged_commit=row["merged_commit"],
        paused=row["status"] == "paused",
    )
    questions = [
        Question(id=r["id"], question=r["question"], answer=r["answer"],
                 options=_options(r["options"]), recommended=r["recommended"])
        for r in db.all("SELECT * FROM questions WHERE feature_id = ? ORDER BY id", (fid,))
    ]
    acceptance = acceptance_of(db, fid)
    findings = findings_of(db, fid)
    ci_runs = ci_runs_of(db, fid)
    return FeatureDetail(
        feature=feature, questions=questions, tasks=tasks, acceptance=acceptance,
        findings=findings, ci_runs=ci_runs, spend_by_agent=_spend_by_agent(db, fid),
        checklist=_checklist(db, row, tasks, acceptance, findings, ci_runs, adr),
    )


def _options(raw: str | None) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except ValueError:
        return []
    return [str(o) for o in value] if isinstance(value, list) else []
