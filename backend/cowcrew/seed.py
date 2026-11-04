"""Demo data matching the designs: project "orbit-api", five showcase features and a short
history of merged work so the overview's spend and trends look alive.

Seeded features are `managed = 0`: the orchestrator never drives them unless you pause and
resume one yourself.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from cowcrew.db import Database, dumps, to_iso
from cowcrew.events import EventBus
from cowcrew.github import SIM_LOG
from cowcrew.gitops import slugify
from cowcrew.models import DEFAULT_MODELS

GITHUB_REPO = "acme/orbit-api"
NOW = datetime.now(UTC)


def _ts(hours_ago: float) -> str:
    return to_iso(NOW - timedelta(hours=hours_ago))


@dataclass
class TaskSpec:
    title: str
    label: str
    status: str = "committed"
    attempts: int = 1
    kind: str = "plan"
    criteria: list[str] = field(default_factory=list)


@dataclass
class Seeder:
    db: Database
    bus: EventBus
    project_id: int
    rng: random.Random

    def feature(self, title: str, status: str, created_h: float, spec: str,
                **fields: Any) -> int:
        slug = slugify(title)
        return self.db.insert(
            "features", project_id=self.project_id, title=title, slug=slug, spec=spec,
            status=status, managed=0, created_at=_ts(created_h), updated_at=_ts(0.05),
            **fields)

    def event(self, fid: int, hours_ago: float, agent: str, kind: str, message: str,
              data: dict[str, Any] | None = None, task_id: int | None = None) -> None:
        self.bus.emit(fid, agent, kind, message, data, task_id=task_id, ts=_ts(hours_ago))

    def run(self, fid: int, hours_ago: float, agent: str, task_id: int | None = None) -> None:
        """One finished agent run: a couple of tool events plus its cost event."""
        lo, hi = {"product_architect": (0.25, 0.7), "software_engineer": (0.6, 1.6),
                  "tester": (0.12, 0.4), "pr_reviewer": (0.3, 0.8),
                  "oncall_engineer": (0.08, 0.25)}[agent]
        cost = round(self.rng.uniform(lo, hi), 4)
        tokens_in = self.rng.randint(40_000, 160_000)
        tokens_out = tokens_in // self.rng.randint(8, 14)
        tools = self.rng.randint(6, 22)
        self.db.execute(
            "UPDATE features SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, "
            "tokens_out = tokens_out + ?, tool_calls = tool_calls + ? WHERE id = ?",
            (cost, tokens_in, tokens_out, tools, fid))
        self.event(fid, hours_ago, agent, "cost", f"run: ${cost:.2f} · {tools} turns", {
            "cost_usd": cost, "model": DEFAULT_MODELS[agent], "input_tokens": tokens_in,
            "output_tokens": tokens_out, "num_turns": tools,
            "context_pct": round(self.rng.uniform(18, 72), 1)}, task_id)

    def plan(self, fid: int, specs: list[TaskSpec], start_h: float, end_h: float) -> list[int]:
        """Insert tasks; committed ones get SWE/Tester runs, verdicts and commits over time."""
        ids = []
        step = (start_h - end_h) / max(1, len(specs))
        for seq, spec in enumerate(specs, start=1):
            at = start_h - step * seq
            committed = spec.status == "committed"
            criteria = spec.criteria or [f"{spec.title} works as specified",
                                         "Covered by unit tests"]
            tid = self.db.insert(
                "tasks", feature_id=fid, seq=seq, title=spec.title,
                description=f"{spec.title}. Follow existing patterns in the codebase.",
                acceptance_criteria=dumps(criteria), depends_on=f"{seq - 1:03d}" if seq > 1
                else "", label=spec.label, status=spec.status, attempts=spec.attempts,
                kind=spec.kind, commit_sha=f"{self.rng.getrandbits(160):040x}" if committed
                else None, committed_at=_ts(at) if committed else None)
            ids.append(tid)
            for attempt in range(1, spec.attempts + 1):
                if spec.status == "pending":
                    break
                t = at + step * (spec.attempts - attempt + 0.6) / (spec.attempts + 1)
                final = attempt == spec.attempts
                if final and not committed:
                    break  # this attempt is still in progress
                self.event(fid, t, "software_engineer", "handoff",
                           f"SWE → Tester: {spec.title} implemented with tests", task_id=tid)
                self.run(fid, t, "software_engineer", tid)
                verdict = "PASS" if final else "FAIL"
                self.run(fid, t - step * 0.1, "tester", tid)
                self.event(fid, t - step * 0.1, "tester", "verdict",
                           f"{verdict} task {seq:03d} · {self.rng.randint(60, 140)} tests",
                           {"verdict": verdict, "attempt": attempt}, tid)
            if committed:
                self.event(fid, at, "system", "status", f"Committed task {seq:03d}", task_id=tid)
        return ids

    def findings(self, fid: int, items: list[tuple[int, str, str, int | None, str, str]]) -> None:
        for round_no, severity, file, line, text, status in items:
            self.db.insert("findings", feature_id=fid, round=round_no, severity=severity,
                           file=file, line=line, text=text, status=status)

    def acceptance(self, fid: int, hours_ago: float, criteria: list[str]) -> None:
        self.run(fid, hours_ago, "product_architect")
        self.db.insert("acceptances", feature_id=fid, verdict="ACCEPT",
                       summary="Does what the spec asked; errors are clear and actionable.",
                       criteria=dumps([{"text": c, "met": True} for c in criteria]),
                       issues="[]", created_at=_ts(hours_ago))
        self.event(fid, hours_ago, "product_architect", "verdict",
                   "ACCEPT: does what the spec asked", {"verdict": "ACCEPT"})

    def green_ci(self, fid: int, hours_ago: float, run_id: str) -> None:
        self.db.insert("ci_runs", feature_id=fid, run_id=run_id, status="success", jobs=dumps([
            {"name": "lint", "conclusion": "success", "duration_seconds": 41},
            {"name": "unit-tests", "conclusion": "success", "duration_seconds": 198},
            {"name": "build", "conclusion": "success", "duration_seconds": 87}]),
            created_at=_ts(hours_ago))
        self.event(fid, hours_ago, "oncall_engineer", "verdict", "CI green",
                   {"conclusion": "success"})


def _rate_limiting(s: Seeder) -> None:
    fid = s.feature(
        "Rate limiting for public API", "building", 5.0,
        "Add per-API-key rate limiting to the public /v1 API with 429 + Retry-After.",
        branch="feat/rate-limiting-for-public-api", workspace_ready=1, approved_at=_ts(4.5),
        adr=dumps({"title": "ADR-0006: Token bucket in Redis",
                   "body": "## Decision\nToken bucket per API key, counters in Redis."}),
        glossary_terms=dumps(["API key", "Token bucket"]),
        estimate=dumps({"hours_min": 3, "hours_max": 5, "cost_min": 8, "cost_max": 15,
                        "files": 11}),
        diff_stats=dumps({"files": 9, "additions": 418, "deletions": 37}))
    for q, a in [("Limit per API key or per IP?", "Per API key; anonymous by IP."),
                 ("Fail open if Redis is down?", "Fail open and log a warning.")]:
        s.db.insert("questions", feature_id=fid, question=q, answer=a)
    s.run(fid, 4.9, "product_architect")
    s.run(fid, 4.7, "product_architect")
    s.event(fid, 4.5, "human", "gate", "Plan approved", {"gate": "plan", "approved": True})
    ids = s.plan(fid, [
        TaskSpec("Token bucket limiter core", "core"),
        TaskSpec("Redis-backed counter store", "data", attempts=2),
        TaskSpec("Per-key limits from config", "config"),
        TaskSpec("429 responses with Retry-After", "api", status="running", attempts=2),
        TaskSpec("Rate-limit headers on every response", "api", status="pending", attempts=0),
        TaskSpec("Admin override endpoint", "api", status="pending", attempts=0),
        TaskSpec("Docs and load test", "docs", status="pending", attempts=0),
    ], start_h=4.4, end_h=0.0)
    current = ids[3]
    s.db.update("features", fid, current_task_id=current)
    s.event(fid, 0.44, "tester", "handoff",
            "Tester → SWE: Retry-After is 0 when the bucket refills within the same second",
            task_id=current)
    s.event(fid, 0.4, "software_engineer", "handoff", "SWE picks up task 004 (attempt 2)",
            task_id=current)
    s.event(fid, 0.3, "software_engineer", "log",
            "Writing a regression test: Retry-After must round up to at least 1 second.",
            task_id=current)
    for i, msg in enumerate(["Edit tests/unit/test_limiter.py", "Bash: uv run pytest -q",
                             "Edit src/orbit/ratelimit/middleware.py"]):
        s.event(fid, 0.2 - i * 0.05, "software_engineer", "tool", msg, task_id=current)


def _sso(s: Seeder) -> None:
    fid = s.feature(
        "SSO with Google Workspace", "awaiting_plan_approval", 1.6,
        "Let customers sign in with their Google Workspace accounts; admins can enforce SSO.",
        adr=dumps({"title": "ADR-0007: Google Workspace SSO via OIDC",
                   "body": "## Status\nAccepted\n\n## Context\nCustomers want Workspace "
                           "sign-in.\n\n## Decision\nUse OIDC with the existing session "
                           "store; map Workspace domain to Organization.\n\n## Consequences\n"
                           "No SAML for now; one new dependency (authlib)."}),
        glossary_terms=dumps(["Workspace domain", "IdP session"]),
        estimate=dumps({"hours_min": 3, "hours_max": 5, "cost_min": 9, "cost_max": 16,
                        "files": 14}))
    for q, a in [
        ("Should SSO be optional or enforceable per organization?",
         "Enforceable by org admins; optional by default."),
        ("Map users by email or by Google subject id?", "Subject id, email as fallback."),
        ("Just-in-time provisioning for unknown users?", "Yes, as Member role."),
    ]:
        s.db.insert("questions", feature_id=fid, question=q, answer=a)
    s.run(fid, 1.5, "product_architect")
    s.event(fid, 1.4, "product_architect", "gate", "3 questions need your answers",
            {"gate": "answers"})
    s.event(fid, 1.0, "human", "log", "Answered 3 question(s)")
    s.run(fid, 0.7, "product_architect")
    for seq, (title, label) in enumerate([
        ("OIDC client configuration", "config"), ("Google sign-in callback", "auth"),
        ("Link Workspace domain to Organization", "data"), ("Just-in-time provisioning", "auth"),
        ("Enforce SSO per organization", "auth"), ("Docs and e2e sign-in test", "docs"),
    ], start=1):
        s.db.insert("tasks", feature_id=fid, seq=seq, title=title, label=label,
                    description=f"{title}. Implements ADR-0007.",
                    acceptance_criteria=dumps([f"{title} works end to end",
                                               "Unauthenticated access returns 401"]),
                    depends_on=f"{seq - 1:03d}" if seq > 1 else "")
    s.event(fid, 0.65, "product_architect", "gate",
            "Plan ready: 6 tasks + ADR “ADR-0007: Google Workspace SSO via OIDC” — approve it",
            {"gate": "plan"})


def _invoice(s: Seeder) -> None:
    criteria = ["Invoice PDF downloads from /v1/invoices/{id}.pdf",
                "PDF matches the invoice totals", "Non-owners get 404",
                "Large invoices stream without timeouts", "Download is logged"]
    fid = s.feature(
        "Invoice PDF export", "awaiting_merge", 26.0,
        "Customers can download any invoice as a PDF from the API.",
        branch="feat/invoice-pdf-export", workspace_ready=1, approved_at=_ts(25),
        pr_number=42, pr_url=f"https://github.com/{GITHUB_REPO}/pull/42", review_round=2,
        ci_enabled=1, ready_at=_ts(2.0),
        diff_stats=dumps({"files": 14, "additions": 612, "deletions": 88}),
        estimate=dumps({"hours_min": 2, "hours_max": 4, "cost_min": 6, "cost_max": 12,
                        "files": 12}))
    s.run(fid, 25.8, "product_architect")
    s.run(fid, 25.4, "product_architect")
    s.plan(fid, [
        TaskSpec("PDF renderer service", "core", criteria=criteria[:2]),
        TaskSpec("Invoice PDF endpoint", "api", attempts=2, criteria=criteria[2:3]),
        TaskSpec("Streaming for large invoices", "perf", criteria=criteria[3:4]),
        TaskSpec("Audit download events", "data", criteria=criteria[4:]),
        TaskSpec("Docs and e2e download test", "docs"),
    ], start_h=25.0, end_h=8.0)
    s.acceptance(fid, 7.5, criteria)
    s.run(fid, 7.0, "pr_reviewer")
    s.event(fid, 7.0, "pr_reviewer", "verdict", "Round 1: 1 blockers, 3 nits",
            {"blockers": 1, "nits": 3, "round": 1})
    s.findings(fid, [
        (1, "Blocker", "src/orbit/invoices/pdf.py", 88,
         "Renderer loads every line item into memory; stream rows instead.", "fixed"),
        (1, "Nit", "src/orbit/invoices/pdf.py", 23, "naming: render() → render_invoice()",
         "noted"),
        (1, "Nit", "tests/unit/test_invoice_pdf.py", 140, "shrink: fixture duplicates factory",
         "noted"),
        (1, "Nit", "docs/api.md", None, "doc polish: add a curl example", "noted"),
    ])
    rollup = s.db.insert(
        "tasks", feature_id=fid, seq=6, title="[PR review rollup] Invoice PDF export",
        description="Fix every Blocker in one coordinated pass.", label="rollup",
        acceptance_criteria=dumps(["Blocker — src/orbit/invoices/pdf.py:88: stream rows"]),
        status="committed", attempts=1, kind="rollup",
        commit_sha=f"{s.rng.getrandbits(160):040x}", committed_at=_ts(5.0))
    s.run(fid, 5.6, "software_engineer", rollup)
    s.run(fid, 5.2, "tester", rollup)
    s.event(fid, 5.2, "tester", "verdict", "PASS task 006 · 118 tests", {"verdict": "PASS"},
            rollup)
    s.run(fid, 4.5, "pr_reviewer")
    s.event(fid, 4.5, "pr_reviewer", "verdict", "Round 2: 0 blockers, 0 nits",
            {"blockers": 0, "nits": 0, "round": 2})
    s.event(fid, 4.0, "system", "status", "Opened PR #42")
    s.green_ci(fid, 2.1, "9184412")
    s.event(fid, 2.0, "system", "gate", "Ready to merge — your review", {"gate": "merge"})


def _flaky(s: Seeder) -> None:
    fid = s.feature(
        "Fix flaky checkout test", "ci", 7.0,
        "test_checkout_total_is_stable fails ~1 in 20 CI runs; make it deterministic.",
        branch="feat/fix-flaky-checkout-test", workspace_ready=1, approved_at=_ts(6.6),
        pr_number=44, pr_url=f"https://github.com/{GITHUB_REPO}/pull/44", review_round=1,
        ci_enabled=1, ci_rounds=1, diff_stats=dumps({"files": 3, "additions": 46,
                                                     "deletions": 19}))
    s.run(fid, 6.9, "product_architect")
    s.plan(fid, [TaskSpec("Deterministic cart fixture", "tests"),
                 TaskSpec("Order-independent total assertion", "tests")], 6.5, 3.0)
    s.acceptance(fid, 2.8, ["Checkout tests pass 50 runs in random order"])
    s.run(fid, 2.5, "pr_reviewer")
    s.event(fid, 2.5, "pr_reviewer", "verdict", "Round 1: 0 blockers, 0 nits",
            {"blockers": 0, "nits": 0, "round": 1})
    s.event(fid, 2.2, "system", "status", "Opened PR #44")
    s.db.insert("ci_runs", feature_id=fid, run_id="9190331", status="failure", jobs=dumps([
        {"name": "lint", "conclusion": "success", "duration_seconds": 39},
        {"name": "unit-tests", "conclusion": "failure", "duration_seconds": 212},
        {"name": "build", "conclusion": "skipped", "duration_seconds": None}]),
        failing_job="unit-tests", failing_log=SIM_LOG, created_at=_ts(1.2),
        diagnosis=dumps({
            "root_cause": "Cart fixture is module-scoped; another test mutates its lines "
                          "before this one runs under pytest-randomly.",
            "responsible_task": "001",
            "why_missed": "Locally the suite runs in file order, so the mutation never "
                          "happens first.",
            "fix_task": "Make the cart fixture function-scoped"}))
    s.event(fid, 1.2, "oncall_engineer", "verdict", "CI red: unit-tests failed",
            {"conclusion": "failure", "job": "unit-tests"})
    s.run(fid, 0.8, "oncall_engineer")
    s.event(fid, 0.75, "oncall_engineer", "log",
            "Reproduced with `pytest -p randomly -p no:cacheprovider`; fixture scope leaks state.")


def _audit(s: Seeder) -> None:
    fid = s.feature(
        "Audit log export", "merged", 98.0,
        "Org admins can export the audit log as CSV for a date range.",
        branch="feat/audit-log-export", workspace_ready=1, approved_at=_ts(97), pr_number=39,
        pr_url=f"https://github.com/{GITHUB_REPO}/pull/39", review_round=1, ci_enabled=1,
        ready_at=_ts(76), finished_at=_ts(74), merged_commit=f"{s.rng.getrandbits(160):040x}",
        diff_stats=dumps({"files": 8, "additions": 304, "deletions": 21}))
    s.run(fid, 97.8, "product_architect")
    s.plan(fid, [TaskSpec("Audit query by date range", "data"),
                 TaskSpec("CSV streaming endpoint", "api", attempts=2),
                 TaskSpec("Admin-only authorization", "auth"),
                 TaskSpec("Docs", "docs")], 96.0, 80.0)
    s.acceptance(fid, 79.0, ["CSV export covers the date range", "Non-admins get 403"])
    s.run(fid, 78.0, "pr_reviewer")
    s.findings(fid, [(1, "Nit", "src/orbit/audit/export.py", 12, "naming: prefer iso_range",
                      "noted")])
    s.green_ci(fid, 76.5, "9101187")
    s.event(fid, 74, "human", "gate", "Merged", {"gate": "merge", "approved": True})


HISTORY = [
    ("Webhook retries with backoff", 13.0, 5.5, 2), ("Team invitations by email", 11.5, 7.0, 1),
    ("CSV import for contacts", 10.0, 8.5, 2), ("Usage metering endpoint", 8.5, 4.0, 1),
    ("Password reset hardening", 6.0, 6.0, 0), ("Pagination for /v1/orders", 5.0, 3.5, 1),
    ("Customer search by email", 2.5, 3.0, 0),
]


def _history(s: Seeder) -> None:
    """Older merged features: they feed the lead-time, loops and blockers trends."""
    for title, days_ago, lead_h, blockers in HISTORY:
        created_h = days_ago * 24
        ready_h = created_h - lead_h
        fid = s.feature(title, "merged", created_h, f"{title}.", ready_at=_ts(ready_h),
                        finished_at=_ts(ready_h - 1), approved_at=_ts(created_h - 0.3),
                        workspace_ready=1, branch=f"feat/{slugify(title)}", ci_enabled=1,
                        merged_commit=f"{s.rng.getrandbits(160):040x}")
        s.run(fid, created_h - 0.1, "product_architect")
        n = s.rng.randint(3, 6)
        s.plan(fid, [TaskSpec(f"{title} — part {i}", "core",
                              attempts=s.rng.choice([1, 1, 1, 2, 2, 3])) for i in range(1, n + 1)],
               created_h - 0.3, ready_h + 0.6)
        s.acceptance(fid, ready_h + 0.5, [f"{title} works"])
        s.run(fid, ready_h + 0.3, "pr_reviewer")
        s.findings(fid, [(1, "Blocker", "src/orbit/app.py", 10 + i, "untested branch", "fixed")
                         for i in range(blockers)])
        s.green_ci(fid, ready_h + 0.1, str(9_000_000 + fid))


def seed(db: Database, bus: EventBus | None = None) -> int:
    """Replace any previous demo project with fresh demo data; returns the project id."""
    bus = bus or EventBus(db)
    db.execute("DELETE FROM projects WHERE name = 'orbit-api'")
    project_id = db.insert(
        "projects", name="orbit-api", repo_path=str(Path.home() / "code" / "orbit-api"),
        default_branch="main", github_repo=GITHUB_REPO, created_at=_ts(24 * 30))
    s = Seeder(db, bus, project_id, random.Random(42))
    _history(s)
    _audit(s)
    _invoice(s)
    _flaky(s)
    _sso(s)
    _rate_limiting(s)
    return project_id
