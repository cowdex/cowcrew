"""Resumable pipeline state machine: one asyncio task per feature, driven by `Feature.status`.

Every running status has a handler that does one unit of work, persists its results and moves
the feature to the next status via `_transition`. Because all progress lives in the database,
a feature can be paused (between agent runs), resumed, or recovered after a restart: on startup
running features become `paused` with their `resume_status` kept.

Human gates (`awaiting_answers`, `awaiting_plan_approval`, `awaiting_merge`) have no handler;
the API moves the feature on and calls `advance()`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sqlite3
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from cowcrew import gitops
from cowcrew.agents import briefs
from cowcrew.agents.runner import AgentError, AgentJob, BaseRunner
from cowcrew.db import Database, dumps, loads, now_iso
from cowcrew.events import EventBus
from cowcrew.github import CIProvider, GitHubError, Target
from cowcrew.gitops import GitError
from cowcrew.models import (
    AGENT_SHORT,
    RUNNING_STATES,
    TERMINAL_STATES,
    AcceptOutput,
    GrillOutput,
    GroomOutput,
    MergeBody,
    OnCallOutput,
    ReviewOutput,
    SweOutput,
    Task,
    TesterOutput,
)
from cowcrew.overview import spend_since_days, tokens_since_days
from cowcrew.settings import Config, SettingsStore, gh_available
from cowcrew.store import tasks_of

log = logging.getLogger("cowcrew.orchestrator")

PA, SWE, TESTER, REVIEWER, ONCALL = (
    "product_architect", "software_engineer", "tester", "pr_reviewer", "oncall_engineer",
)
READ = frozenset({"Read", "Glob", "Grep"})
READ_BASH = READ | {"Bash"}
SWE_TOOLS = READ | {"Edit", "Write", "Bash"}
TESTER_TOOLS = READ | {"Bash", "Write"}
MAX_ACCEPT_ROUNDS = 2
MAX_REVIEW_ROUNDS = 3
MAX_CI_ROUNDS = 2
CI_LOG_LIMIT = 6_000


class TransitionError(Exception):
    """The requested action is not legal in the feature's current status (HTTP 409)."""


class PipelineError(Exception):
    """A recoverable problem: the feature is paused with an error event for the human."""


class Orchestrator:
    """Owns the per-feature asyncio tasks and every status transition."""

    def __init__(
        self, db: Database, bus: EventBus, runner: BaseRunner, settings: SettingsStore,
        config: Config, ci: CIProvider,
    ) -> None:
        self.db = db
        self.bus = bus
        self.runner = runner
        self.settings = settings
        self.config = config
        self.ci = ci
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._handlers: dict[str, Callable[[sqlite3.Row], Awaitable[None]]] = {
            "grilling": self._grill,
            "grooming": self._groom,
            "building": self._build,
            "accepting": self._accept,
            "reviewing": self._review,
            "ci": self._ci,
        }

    # ================================================================== lifecycle

    def recover(self) -> None:
        """After a restart, pause every managed feature that was mid-pipeline."""
        rows = self.db.all(
            f"SELECT id, status FROM features WHERE managed = 1 AND status IN "  # noqa: S608
            f"({','.join('?' * len(RUNNING_STATES))})", tuple(RUNNING_STATES),
        )
        for row in rows:
            self._update(row["id"], status="paused", resume_status=row["status"])
            self.bus.emit(row["id"], "system", "status",
                          "Paused after a restart — resume when ready",
                          {"from": row["status"], "to": "paused"})

    def is_running(self, feature_id: int) -> bool:
        task = self._tasks.get(feature_id)
        return task is not None and not task.done()

    def advance(self, feature_id: int) -> None:
        """Start (or keep) the driver task for a feature if its status has work to do."""
        if self.is_running(feature_id):
            return
        self._tasks[feature_id] = asyncio.get_running_loop().create_task(
            self._drive(feature_id), name=f"feature-{feature_id}")

    async def cancel(self, feature_id: int) -> None:
        """Cancel a feature's driver task and wait for it to unwind."""
        task = self._tasks.pop(feature_id, None)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def wait_idle(self, feature_id: int) -> None:
        """Await the feature's driver task (used by tests and shutdown)."""
        task = self._tasks.get(feature_id)
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def shutdown(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _drive(self, fid: int) -> None:
        try:
            while True:
                row = self._row(fid)
                handler = self._handlers.get(row["status"])
                if handler is None:
                    return
                await handler(row)
        except asyncio.CancelledError:
            raise
        except (PipelineError, AgentError, GitError, GitHubError) as exc:
            self._pause(fid, str(exc))
        except Exception as exc:
            log.exception("feature %s failed", fid)
            self._update(fid, status="failed", finished_at=now_iso())
            self.bus.emit(fid, "system", "error", f"Pipeline failed: {exc}")
        finally:
            if self._tasks.get(fid) is asyncio.current_task():
                self._tasks.pop(fid, None)

    # ================================================================== helpers

    def _row(self, fid: int) -> sqlite3.Row:
        row = self.db.one("SELECT * FROM features WHERE id = ?", (fid,))
        if row is None:
            raise KeyError(fid)
        return row

    def _project(self, row: sqlite3.Row) -> sqlite3.Row:
        project = self.db.one("SELECT * FROM projects WHERE id = ?", (row["project_id"],))
        assert project is not None
        return project

    def _update(self, fid: int, **fields: Any) -> None:
        self.db.update("features", fid, **fields, updated_at=now_iso())
        self.bus.feature_changed(fid)

    def _set_task(self, fid: int, task_id: int, **fields: Any) -> None:
        """Update a task and broadcast the feature (board cells and counts change)."""
        self.db.update("tasks", task_id, **fields)
        self.bus.feature_changed(fid)

    def _halted(self, fid: int, expected: str) -> bool:
        """True when the human paused/stopped the feature while an agent was running."""
        return self._row(fid)["status"] != expected

    def _transition(self, fid: int, to: str, message: str, kind: str = "status") -> None:
        """Move to `to`; if the feature was paused meanwhile, only record where to resume."""
        row = self._row(fid)
        if row["status"] == "paused":
            self._update(fid, resume_status=to)
            return
        if row["status"] in TERMINAL_STATES:
            return
        fields: dict[str, Any] = {"status": to}
        if to == "awaiting_merge" and not row["ready_at"]:
            fields["ready_at"] = now_iso()
        self._update(fid, **fields)
        self.bus.emit(fid, "system", kind, message, {"from": row["status"], "to": to})

    def _pause(self, fid: int, reason: str, resume_to: str | None = None) -> None:
        row = self._row(fid)
        if row["status"] in TERMINAL_STATES:
            return
        resume = resume_to or (row["resume_status"] if row["status"] == "paused" else row["status"])
        self._update(fid, status="paused", resume_status=resume)
        self.bus.emit(fid, "system", "error", f"{reason} — paused for you",
                      {"to": "paused", "resume_status": resume})

    def _cwd(self, row: sqlite3.Row) -> Path:
        return Path(row["worktree_path"] or self._project(row)["repo_path"])

    def _notes_for(self, fid: int, agent: str) -> list[str]:
        rows = self.db.all(
            "SELECT id, text FROM messages WHERE feature_id = ? AND agent = ? "
            "AND consumed_at IS NULL ORDER BY id", (fid, agent))
        for r in rows:
            self.db.update("messages", r["id"], consumed_at=now_iso())
        return [r["text"] for r in rows]

    async def _run(self, job: AgentJob) -> Any:
        """Budget check, human notes, then one agent run."""
        if self.settings.billing == "subscription":
            limit, used = self.settings.budget_tokens_week, tokens_since_days(self.db, 7)
            label = f"{limit / 1e6:g}M tokens"
        else:
            limit, used = self.settings.budget_usd_week, spend_since_days(self.db, 7)
            label = f"${limit:.0f}"
        if limit > 0 and used >= limit:
            raise PipelineError(f"Weekly budget of {label} reached — raise it in Settings")
        job.prompt = briefs.with_notes(job.prompt, self._notes_for(job.feature_id, job.agent))
        return await self.runner.run(job)

    def _handoff(
        self, fid: int, agent: str, message: str, task_id: int | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        self.bus.emit(fid, agent, "handoff", message, data, task_id=task_id)

    def _add_task(
        self, row: sqlite3.Row, kind: str, title: str, description: str, criteria: list[str],
        label: str,
    ) -> int:
        seq = int(self.db.scalar("SELECT COALESCE(MAX(seq), 0) FROM tasks WHERE feature_id = ?",
                                 (row["id"],))) + 1
        task_id = self.db.insert(
            "tasks", feature_id=row["id"], seq=seq, title=title, description=description,
            acceptance_criteria=dumps(criteria), depends_on="", label=label, kind=kind)
        if row["worktree_path"]:
            task = next(t for t in tasks_of(self.db, row["id"]) if t.id == task_id)
            gitops.write_files(Path(row["worktree_path"]), {_task_path(task): _task_md(task, row)})
        return task_id

    def _ci_enabled(self, project: sqlite3.Row) -> bool:
        if self.config.simulate:
            return True
        return bool(project["github_repo"]) and gh_available()

    def _target(self, row: sqlite3.Row) -> Target:
        project = self._project(row)
        return Target(
            feature_id=row["id"],
            cwd=Path(row["worktree_path"]) if row["worktree_path"] else None,
            repo=project["github_repo"], branch=row["branch"] or "",
            base=project["default_branch"])

    async def _refresh_diff(self, fid: int) -> None:
        row = self._row(fid)
        if not row["worktree_path"]:
            return
        base = self._project(row)["default_branch"]
        diff = await asyncio.to_thread(gitops.diff_summary, row["worktree_path"], base)
        self._update(fid, protected_touched=int(diff.protected_touched),
                     diff_stats=dumps({"files": diff.files, "additions": diff.additions,
                                       "deletions": diff.deletions}))

    # ================================================================== states

    async def _grill(self, row: sqlite3.Row) -> None:
        """grilling: the PA reads the spec against the repo and asks 0-5 questions."""
        fid = row["id"]
        cwd = self._cwd(row)
        out: GrillOutput = await self._run(AgentJob(
            agent=PA, phase="grill", feature_id=fid, task_id=None,
            title=f"Grilling the spec for {row['title']}", cwd=cwd, output=GrillOutput,
            prompt=briefs.grill(cwd, row["title"], row["spec"]), tools=READ, max_turns=40,
            context={"feature_title": row["title"]}))
        questions = [q.strip() for q in out.questions if q.strip()][:5]
        for question in questions:
            self.db.insert("questions", feature_id=fid, question=question)
        if questions:
            self.bus.emit(fid, PA, "gate", f"{len(questions)} questions need your answers",
                          {"gate": "answers"})
            self._transition(fid, "awaiting_answers", "Waiting for your answers")
        else:
            self._transition(fid, "grooming", "No open questions — grooming the plan")

    async def _groom(self, row: sqlite3.Row) -> None:
        """grooming: the PA turns spec + answers (+ change note) into tasks, ADR and estimate."""
        fid = row["id"]
        cwd = self._cwd(row)
        qa = [(r["question"], r["answer"] or "(no answer)") for r in self.db.all(
            "SELECT question, answer FROM questions WHERE feature_id = ? ORDER BY id", (fid,))]
        out: GroomOutput = await self._run(AgentJob(
            agent=PA, phase="groom", feature_id=fid, task_id=None,
            title=f"Grooming the plan for {row['title']}", cwd=cwd, output=GroomOutput,
            prompt=briefs.groom(cwd, row["title"], row["spec"], qa, row["change_note"]),
            tools=READ, max_turns=80, context={"feature_title": row["title"]}))
        self.db.execute("DELETE FROM tasks WHERE feature_id = ?", (fid,))
        for seq, task in enumerate(out.tasks, start=1):
            self.db.insert(
                "tasks", feature_id=fid, seq=seq, title=task.title, description=task.description,
                acceptance_criteria=dumps(task.acceptance_criteria), depends_on=task.depends_on,
                label=task.label, kind="plan")
        self._update(
            fid, adr=dumps(out.adr.model_dump()) if out.adr else None,
            glossary_terms=dumps(out.glossary_terms), estimate=dumps(out.estimate.model_dump()),
            change_note=None)
        adr = f" + ADR “{out.adr.title}”" if out.adr else ""
        self.bus.emit(fid, PA, "gate", f"Plan ready: {len(out.tasks)} tasks{adr} — approve it",
                      {"gate": "plan"})
        self._transition(fid, "awaiting_plan_approval", "Waiting for plan approval")

    async def _build(self, row: sqlite3.Row) -> None:
        """building: set up the worktree once, then SWE → Tester → commit for each open task."""
        fid = row["id"]
        if not row["workspace_ready"]:
            await self._setup_workspace(row)
        while True:
            if self._halted(fid, "building"):
                return
            task = next((t for t in tasks_of(self.db, fid)
                         if t.status in {"pending", "running", "testing"}), None)
            if task is None:
                break
            if not await self._run_task(fid, task):
                return
        if any(t.status == "failed" for t in tasks_of(self.db, fid)):
            raise PipelineError("A task is marked failed")
        row = self._row(fid)
        to = row["return_status"] or "accepting"
        self._update(fid, return_status=None, current_task_id=None)
        await self._refresh_diff(fid)
        labels = {"accepting": "PA acceptance", "reviewing": "PR review", "ci": "CI"}
        self._transition(fid, to, f"All tasks committed — on to {labels.get(to, to)}")

    async def _setup_workspace(self, row: sqlite3.Row) -> None:
        """Create `<repo>-<slug>` worktree on `feat/<slug>`, write the plan files, commit them."""
        fid = row["id"]
        project = self._project(row)
        repo = Path(project["repo_path"])
        slug = row["slug"]
        if await asyncio.to_thread(gitops.is_git_repo, repo):
            branch = f"feat/{slug}"
            if await asyncio.to_thread(gitops.branch_exists, repo, branch):
                branch = f"feat/{slug}-{fid}"
            worktree = repo.parent / f"{repo.name}-{branch.removeprefix('feat/')}"
            await asyncio.to_thread(gitops.create_worktree, repo, worktree, branch,
                                    project["default_branch"])
            files = {_task_path(t): _task_md(t, row) for t in tasks_of(self.db, fid)}
            adr = loads(row["adr"])
            if adr:
                number = gitops.next_adr_number(worktree)
                files[f"docs/adr/{number:04d}-{gitops.slugify(adr['title'])}.md"] = (
                    f"# ADR-{number:04d}: {adr['title']}\n\n{adr['body'].strip()}\n")
            await asyncio.to_thread(gitops.write_files, worktree, files)
            await asyncio.to_thread(gitops.commit_all, worktree, f"chore(plan): {row['title']}")
            self._update(fid, branch=branch, worktree_path=str(worktree), workspace_ready=1)
            self.bus.emit(fid, "system", "status",
                          f"Worktree ready on {branch} — plan committed",
                          {"worktree": str(worktree)})
        elif self.config.simulate:
            self._update(fid, branch=f"feat/{slug}", workspace_ready=1)
            self.bus.emit(fid, "system", "status",
                          f"Simulated workspace on feat/{slug} (repo is not a git checkout)")
        else:
            raise PipelineError(f"{repo} is not a git repository")

    async def _run_task(self, fid: int, task: Task) -> bool:
        """SWE ⇄ Tester loop for one task. Returns False when the feature must stop here."""
        self._update(fid, current_task_id=task.id)
        title = self._row(fid)["title"]
        report = self.db.scalar("SELECT last_report FROM tasks WHERE id = ?", (task.id,))
        status, attempts = task.status, task.attempts
        while True:
            row = self._row(fid)
            cwd = self._cwd(row)
            ctx = {"feature_title": title, "task_title": task.title, "seq": task.seq,
                   "kind": task.kind}
            if status != "testing":
                attempts += 1
                self._set_task(fid, task.id, status="running", attempts=attempts)
                self._handoff(fid, SWE, f"SWE picks up task {task.seq:03d}"
                              + (f" (attempt {attempts})" if attempts > 1 else ""), task.id,
                              {"attempt": attempts})
                swe: SweOutput = await self._run(AgentJob(
                    agent=SWE, phase="implement", feature_id=fid, task_id=task.id,
                    title=f"Task {task.seq:03d}: {task.title}", cwd=cwd, output=SweOutput,
                    prompt=briefs.implement(cwd, title, task, attempts, report),
                    tools=SWE_TOOLS, write_scope="any", max_turns=200,
                    context={**ctx, "attempt": attempts}))
                self._set_task(fid, task.id, status="testing", last_report=swe.summary)
                self._handoff(fid, SWE, f"SWE → Tester: {swe.summary}", task.id)
                if self._halted(fid, "building"):
                    return False
                report = swe.summary
            verdict: TesterOutput = await self._run(AgentJob(
                agent=TESTER, phase="test", feature_id=fid, task_id=task.id,
                title=f"QA task {task.seq:03d}: {task.title}", cwd=cwd, output=TesterOutput,
                prompt=briefs.test(cwd, title, task, report or ""), tools=TESTER_TOOLS,
                write_scope="tests", max_turns=120, context={**ctx, "attempt": max(1, attempts)}))
            self.bus.emit(
                fid, TESTER, "verdict",
                f"{verdict.verdict} task {task.seq:03d} · {verdict.tests_passed}/"
                f"{verdict.tests_total} tests",
                {"verdict": verdict.verdict, "attempt": attempts, "report": verdict.report,
                 "tests_passed": verdict.tests_passed, "tests_total": verdict.tests_total},
                task_id=task.id)
            if verdict.verdict == "PASS":
                await self._commit_task(fid, task)
                return True
            self._set_task(fid, task.id, last_report=verdict.report)
            report = verdict.report
            if attempts >= self.settings.max_attempts:
                self._set_task(fid, task.id, status="failed")
                self._pause(fid, f"Task {task.seq:03d} failed QA {attempts} times",
                            resume_to="building")
                return False
            self._set_task(fid, task.id, status="running")
            status = "running"
            self._handoff(fid, TESTER, f"Tester → SWE: fix and retry task {task.seq:03d}",
                          task.id)
            if self._halted(fid, "building"):
                return False

    async def _commit_task(self, fid: int, task: Task) -> None:
        row = self._row(fid)
        message = f"feat({row['slug']}): {task.title} (task {task.seq:03d})"
        if row["worktree_path"]:
            sha = await asyncio.to_thread(gitops.commit_all, row["worktree_path"], message)
        else:
            sha = uuid.uuid4().hex + uuid.uuid4().hex[:8]
        self._set_task(fid, task.id, status="committed", commit_sha=sha,
                       committed_at=now_iso())
        self.bus.emit(fid, "system", "status", f"Committed task {task.seq:03d} · {sha[:7]}",
                      {"sha": sha, "message": message}, task_id=task.id)
        await self._refresh_diff(fid)

    async def _accept(self, row: sqlite3.Row) -> None:
        """accepting: PA acceptance from the user's view; REJECT → one rollup task."""
        fid = row["id"]
        cwd = self._cwd(row)
        base = self._project(row)["default_branch"]
        tasks = tasks_of(self.db, fid)
        criteria = [c for t in tasks if t.kind == "plan" for c in t.acceptance_criteria]
        self._handoff(fid, PA, "PA starts the acceptance review")
        out: AcceptOutput = await self._run(AgentJob(
            agent=PA, phase="accept", feature_id=fid, task_id=None,
            title=f"Acceptance review of {row['title']}", cwd=cwd, output=AcceptOutput,
            prompt=briefs.accept(cwd, row["title"], row["spec"], tasks, base), tools=READ_BASH,
            max_turns=60, context={"feature_title": row["title"], "criteria": criteria}))
        self.db.insert(
            "acceptances", feature_id=fid, verdict=out.verdict, summary=out.summary,
            criteria=dumps([c.model_dump() for c in out.criteria]), issues=dumps(out.issues),
            created_at=now_iso())
        self.bus.emit(fid, PA, "verdict", f"{out.verdict}: {out.summary}",
                      {"verdict": out.verdict, "issues": out.issues})
        if out.verdict == "ACCEPT":
            self._transition(fid, "reviewing", "Accepted — on to PR review")
            return
        rounds = row["accept_rounds"] + 1
        self._update(fid, accept_rounds=rounds, return_status="accepting")
        self._add_task(row, "rollup", f"[PA rejection] {row['title']}",
                       "Fix every issue from the acceptance review in one coordinated pass.",
                       out.issues or [out.summary], "rollup")
        if rounds > MAX_ACCEPT_ROUNDS:
            self._pause(fid, f"PA rejected {rounds} times", resume_to="building")
        else:
            self._transition(fid, "building", "Rejected — rollup task queued for the SWE")

    async def _review(self, row: sqlite3.Row) -> None:
        """reviewing: PR Reviewer tags Blocker/Nit; Blockers → one rollup task and another round."""
        fid = row["id"]
        round_no = row["review_round"] + 1
        self._update(fid, review_round=round_no)
        cwd = self._cwd(row)
        base = self._project(row)["default_branch"]
        diff = (await asyncio.to_thread(gitops.diff_text, cwd, base) if row["worktree_path"]
                else "(simulated workspace: no diff available)")
        reviewed = (await asyncio.to_thread(gitops.head_sha, cwd) if row["worktree_path"]
                    else None)
        self._update(fid, verified_sha=reviewed)
        prior = self.db.all("SELECT id, file, text FROM findings WHERE feature_id = ? AND "
                            "severity = 'Blocker' AND status = 'open'", (fid,))
        self._handoff(fid, REVIEWER, f"PR Reviewer starts round {round_no}")
        out: ReviewOutput = await self._run(AgentJob(
            agent=REVIEWER, phase="review", feature_id=fid, task_id=None,
            title=f"Review round {round_no} of {row['title']}", cwd=cwd, output=ReviewOutput,
            prompt=briefs.review(cwd, row["title"], base, diff, round_no,
                                 [f"{p['file']}: {p['text']}" for p in prior]),
            tools=READ_BASH, max_turns=80,
            context={"feature_title": row["title"], "round": round_no}))
        blockers = [f for f in out.findings if f.severity == "Blocker"]
        nits = [f for f in out.findings if f.severity == "Nit"]
        for f in out.findings:
            self.db.insert("findings", feature_id=fid, round=round_no, severity=f.severity,
                           file=f.file, line=f.line, text=f.text,
                           status="open" if f.severity == "Blocker" else "noted")
        self.bus.emit(fid, REVIEWER, "verdict",
                      f"Round {round_no}: {len(blockers)} blockers, {len(nits)} nits",
                      {"blockers": len(blockers), "nits": len(nits), "round": round_no})
        if not blockers:
            for p in prior:
                self.db.update("findings", p["id"], status="fixed")
            self._after_review(fid)
            return
        self._update(fid, return_status="reviewing")
        self._add_task(
            row, "rollup", f"[PR review rollup] {row['title']}",
            "Fix every Blocker in one coordinated pass; Nits are optional.",
            [f"Blocker — {_where(b.file, b.line)}: {b.text}" for b in blockers],
            "rollup")
        if round_no >= MAX_REVIEW_ROUNDS:
            self._pause(fid, f"Blockers remain after {round_no} review rounds",
                        resume_to="building")
        else:
            self._transition(fid, "building", f"{len(blockers)} blockers — rollup task queued")

    def _after_review(self, fid: int) -> None:
        row = self._row(fid)
        if self._ci_enabled(self._project(row)):
            self._update(fid, ci_enabled=1)
            self._transition(fid, "ci", "No blockers — pushing for CI")
            return
        self._update(fid, ci_enabled=0)
        self._enter_merge_gate(fid, "No blockers · no CI configured — ready for your review")

    def _check_verified(self, fid: int) -> None:
        """The branch head must still be the commit the reviewer saw; newer is unreviewed."""
        row = self._row(fid)
        if not row["worktree_path"] or not row["verified_sha"]:
            return
        head = gitops.head_sha(row["worktree_path"])
        if head != row["verified_sha"]:
            raise PipelineError(
                f"Branch moved after review ({row['verified_sha'][:7]} → {head[:7]}); "
                "unreviewed commits won't be merged")

    def _enter_merge_gate(self, fid: int, message: str) -> None:
        self._check_verified(fid)
        self._transition(fid, "awaiting_merge", message)
        if self._row(fid)["status"] == "awaiting_merge":
            self.bus.emit(fid, "system", "gate", "Ready to merge — your review", {"gate": "merge"})

    def _pr_body(self, fid: int) -> str:
        acceptance = self.db.one("SELECT summary FROM acceptances WHERE feature_id = ? "
                                 "ORDER BY id DESC LIMIT 1", (fid,))
        tasks = "\n".join(f"- {t.seq:03d} {t.title}" for t in tasks_of(self.db, fid))
        nits = "\n".join(f"- {r['file']}: {r['text']}" for r in self.db.all(
            "SELECT file, text FROM findings WHERE feature_id = ? AND severity = 'Nit'", (fid,)))
        summary = acceptance["summary"] if acceptance else ""
        return (f"{summary}\n\n## Tasks\n{tasks}\n\n## Nits (non-blocking)\n{nits or '- none'}\n\n"
                "_Built by CowCrew._")

    async def _ci(self, row: sqlite3.Row) -> None:
        """ci: push, open the PR, poll checks; red → On-Call diagnosis → fix task → building."""
        fid = row["id"]
        target = self._target(row)
        await asyncio.to_thread(self.ci.push, target)
        if not row["pr_number"]:
            number, url = await asyncio.to_thread(self.ci.ensure_pr, target, row["title"],
                                                  self._pr_body(fid))
            if number:
                self._update(fid, pr_number=number, pr_url=url)
                self.bus.emit(fid, "system", "status", f"Opened PR #{number}", {"url": url})
        head = (await asyncio.to_thread(gitops.head_sha, target.cwd) if target.cwd
                else f"sim-{row['ci_rounds']}")
        if target.cwd and row["verified_sha"] and head != row["verified_sha"]:
            raise PipelineError(
                f"Branch moved after review ({row['verified_sha'][:7]} → {head[:7]}); "
                "refusing to run CI on unreviewed commits")
        self.bus.emit(fid, ONCALL, "status", f"Watching CI for {head[:7]}")
        poll = (2.0 * self.config.sim_speed if self.config.simulate
                else self.config.ci_poll_seconds)
        started = time.monotonic()
        run_row: int | None = None
        while True:
            if self._halted(fid, "ci"):
                return
            result = await asyncio.to_thread(self.ci.check, target, head)
            elapsed = time.monotonic() - started
            if result.run_ids:
                fields = {"status": result.status, "jobs": dumps(result.jobs),
                          "failing_job": result.failing_job}
                if run_row is None:
                    run_row = self.db.insert("ci_runs", feature_id=fid,
                                             run_id=",".join(result.run_ids),
                                             created_at=now_iso(), **fields)
                else:
                    self.db.update("ci_runs", run_row, **fields)
                self.bus.feature_changed(fid)
                if result.status == "success":
                    self.bus.emit(fid, ONCALL, "verdict", "CI green", {"conclusion": "success"})
                    self._enter_merge_gate(fid, "CI green — ready for your review")
                    return
                if result.status == "failure":
                    break
            elif elapsed > self.config.ci_no_runs_grace_seconds:
                self._update(fid, ci_enabled=0)
                self._enter_merge_gate(fid, "No workflow runs found — treating as no CI")
                return
            if elapsed > self.config.ci_timeout_seconds:
                raise PipelineError("CI did not finish in time")
            await asyncio.sleep(poll)
        assert run_row is not None
        await self._diagnose(row, target, run_row, result.failing_job, result.failing_run_id)

    async def _diagnose(self, row: sqlite3.Row, target: Target, run_row: int,
                        failing_job: str | None, failing_run_id: str | None) -> None:
        fid = row["id"]
        failed_log = (await asyncio.to_thread(self.ci.failed_log, target, failing_run_id)
                      if failing_run_id else "")[-CI_LOG_LIMIT:]
        self.db.update("ci_runs", run_row, failing_log=failed_log)
        self.bus.emit(fid, ONCALL, "verdict", f"CI red: {failing_job or 'a job'} failed",
                      {"conclusion": "failure", "job": failing_job})
        rounds = row["ci_rounds"] + 1
        self._update(fid, ci_rounds=rounds)
        cwd = self._cwd(row)
        tasks = tasks_of(self.db, fid)
        out: OnCallOutput = await self._run(AgentJob(
            agent=ONCALL, phase="diagnose", feature_id=fid, task_id=None,
            title=f"Diagnosing red CI on {row['title']}", cwd=cwd, output=OnCallOutput,
            prompt=briefs.diagnose(cwd, row["title"], failing_job, failed_log, tasks),
            tools=READ_BASH, max_turns=60,
            context={"feature_title": row["title"],
                     "responsible_task": f"{tasks[-1].seq:03d}" if tasks else "001"}))
        self.db.update("ci_runs", run_row, diagnosis=dumps({
            "root_cause": out.root_cause, "responsible_task": out.responsible_task,
            "why_missed": out.why_missed, "fix_task": out.fix_task.title}))
        self._add_task(row, "fix", out.fix_task.title,
                       f"{out.fix_task.description}\n\nRoot cause: {out.root_cause}",
                       out.fix_task.acceptance_criteria, "ci-fix")
        self._handoff(fid, ONCALL, f"On-Call → SWE: {out.fix_task.title}")
        # Code changed: the fix must pass acceptance and PR review again before CI.
        self._update(fid, return_status=None, verified_sha=None)
        if rounds > MAX_CI_ROUNDS:
            self._pause(fid, f"CI still red after {rounds} rounds", resume_to="building")
        else:
            self._transition(fid, "building", "Fix task queued for the SWE")

    # ================================================================== human actions

    def _require(self, fid: int, *statuses: str) -> sqlite3.Row:
        row = self._row(fid)
        if row["status"] not in statuses:
            raise TransitionError(
                f"Feature is {row['status']}; this needs {' or '.join(statuses)}")
        return row

    def create_feature(self, project_id: int, title: str, spec: str) -> int:
        now = now_iso()
        fid = self.db.insert("features", project_id=project_id, title=title,
                             slug=gitops.slugify(title), spec=spec, status="grilling",
                             created_at=now, updated_at=now)
        self.bus.emit(fid, "human", "status", f"New feature: {title}", {"to": "grilling"})
        self.bus.feature_changed(fid)
        self.advance(fid)
        return fid

    def answer(self, fid: int, answers: dict[int, str]) -> None:
        self._require(fid, "awaiting_answers")
        known = {r["id"] for r in self.db.all("SELECT id FROM questions WHERE feature_id = ?",
                                              (fid,))}
        for qid, text in answers.items():
            if qid not in known:
                raise TransitionError(f"Question {qid} does not belong to this feature")
            self.db.update("questions", qid, answer=text.strip() or "(no preference)")
        open_count = self.db.scalar(
            "SELECT COUNT(*) FROM questions WHERE feature_id = ? AND answer IS NULL", (fid,))
        self.bus.emit(fid, "human", "log", f"Answered {len(answers)} question(s)")
        if open_count == 0:
            self._transition(fid, "grooming", "Answers in — PA is grooming the plan")
            self.advance(fid)
        else:
            self.bus.feature_changed(fid)

    def approve(self, fid: int) -> None:
        self._require(fid, "awaiting_plan_approval")
        self._update(fid, approved_at=now_iso())
        self.bus.emit(fid, "human", "gate", "Plan approved", {"gate": "plan", "approved": True})
        self._transition(fid, "building", "Plan approved — building")
        self.advance(fid)

    def request_changes(self, fid: int, note: str) -> None:
        self._require(fid, "awaiting_plan_approval")
        self._update(fid, change_note=note)
        self.bus.emit(fid, "human", "log", f"Requested plan changes: {note}")
        self._transition(fid, "grooming", "Re-grooming with your notes")
        self.advance(fid)

    def pause(self, fid: int) -> None:
        row = self._require(fid, *sorted(RUNNING_STATES))
        self._update(fid, status="paused", resume_status=row["status"])
        self.bus.emit(fid, "human", "status",
                      "Paused — the current agent run finishes, then the pipeline waits",
                      {"from": row["status"], "to": "paused"})

    def resume(self, fid: int) -> None:
        row = self._require(fid, "paused")
        to = row["resume_status"] or "grilling"
        self.db.execute("UPDATE tasks SET status = 'pending', attempts = 0 "
                        "WHERE feature_id = ? AND status = 'failed'", (fid,))
        self._update(fid, status=to, resume_status=None, managed=1)
        self.bus.emit(fid, "human", "status", f"Resumed ({to})", {"from": "paused", "to": to})
        self.advance(fid)

    def stop(self, fid: int) -> None:
        self._require(fid, *sorted({"grilling", "awaiting_answers", "grooming",
                                    "awaiting_plan_approval", "building", "accepting",
                                    "reviewing", "ci", "awaiting_merge", "paused", "failed"}))
        row = self._row(fid)
        task = self._tasks.pop(fid, None)
        if task is not None:
            task.cancel()
        self.db.execute("UPDATE tasks SET status = 'pending' WHERE feature_id = ? "
                        "AND status IN ('running', 'testing')", (fid,))
        step = self._restart_step(fid, row)
        self._update(fid, status="stopped", finished_at=now_iso(), resume_status=step)
        self.bus.emit(fid, "human", "status", "Stopped", {"from": row["status"], "to": "stopped"})

    def _restart_step(self, fid: int, row: Any) -> str:
        """The pipeline step a stopped or failed run should restart from."""
        if row["status"] not in TERMINAL_STATES | {"paused"}:
            return str(row["status"])
        if row["resume_status"]:
            return str(row["resume_status"])
        skip = TERMINAL_STATES | {"paused"}
        for ev in self.db.all("SELECT data FROM events WHERE feature_id = ? "
                                "ORDER BY id DESC", (fid,)):
            try:
                to = json.loads(ev["data"] or "{}").get("to")
            except (ValueError, AttributeError):
                continue
            if isinstance(to, str) and to not in skip:
                return to
        return "grilling"

    def restart(self, fid: int) -> str:
        """Pick a stopped or failed run back up at the step it was on."""
        row = self._require(fid, "stopped", "failed")
        to = self._restart_step(fid, row)
        self.db.execute("UPDATE tasks SET status = 'pending', attempts = 0 "
                        "WHERE feature_id = ? AND status = 'failed'", (fid,))
        self._update(fid, status=to, resume_status=None, finished_at=None, managed=1)
        self.bus.emit(fid, "human", "status", f"Restarted ({to})",
                      {"from": row["status"], "to": to})
        self.advance(fid)
        return to

    def send_back(self, fid: int, note: str) -> None:
        row = self._require(fid, "awaiting_merge")
        self.bus.emit(fid, "human", "gate", f"Sent back: {note}", {"gate": "merge",
                                                                    "approved": False})
        self._add_task(row, "rollup", f"[Send-back] {row['title']}", note, [note], "rollup")
        self._update(fid, return_status=None)
        self._transition(fid, "building", "Sent back — rollup task queued for the SWE")
        self.advance(fid)

    def message(self, fid: int, agent: str, text: str) -> None:
        row = self._row(fid)
        if row["status"] in TERMINAL_STATES:
            raise TransitionError(f"Feature is {row['status']}")
        self.db.insert("messages", feature_id=fid, agent=agent, text=text, created_at=now_iso())
        self.bus.emit(fid, "human", "log", f"Note for {AGENT_SHORT[agent]}: {text}",
                      {"to_agent": agent})

    async def merge(self, fid: int, body: MergeBody) -> int | None:
        """Gate 2. Squash-merge via the PR or locally; returns a follow-up feature id if any."""
        row = self._require(fid, "awaiting_merge")
        project = self._project(row)
        target = self._target(row)
        worktree = Path(row["worktree_path"]) if row["worktree_path"] else None
        repo = Path(project["repo_path"])
        verified = row["verified_sha"]
        if worktree and not verified:  # features that reached the gate before this field existed
            verified = await asyncio.to_thread(gitops.head_sha, worktree)
        if worktree and verified:
            head = await asyncio.to_thread(gitops.head_sha, worktree)
            if head != verified:
                raise TransitionError(
                    f"The branch moved after review ({verified[:7]} → {head[:7]}); "
                    "it needs another review before merging")
        if row["pr_number"] and project["github_repo"] and not self.config.simulate:
            if not verified:
                raise TransitionError("No verified commit recorded for this PR")
            try:
                sha = await asyncio.to_thread(self.ci.merge_pr, target, row["pr_number"],
                                              body.commit_message, body.delete_branch,
                                              verified, body.admin)
            except GitHubError as exc:
                if "match-head-commit" in str(exc) or "head branch was modified" in str(exc):
                    raise TransitionError(
                        "The pull request changed on GitHub after review; "
                        "it needs another review before merging") from exc
                why = await asyncio.to_thread(self.ci.merge_blockers, target, row["pr_number"])
                raise TransitionError(
                    f"GitHub won't merge yet: {why or 'its branch rules are not met'}. "
                    "Approve or wait on GitHub, or tick “Merge as admin” to bypass the rules "
                    "(only if you're a repository admin).") from exc
            if body.delete_branch and worktree:
                await asyncio.to_thread(gitops.remove_worktree, repo, worktree, row["branch"])
        elif worktree:
            if await asyncio.to_thread(gitops.is_dirty, repo):
                raise TransitionError("The main checkout has uncommitted changes")
            branch = await asyncio.to_thread(gitops.current_branch, repo)
            if branch != project["default_branch"]:
                raise TransitionError(
                    f"The main checkout is on '{branch}', not '{project['default_branch']}'")
            try:
                sha = await asyncio.to_thread(gitops.squash_merge, repo, row["branch"],
                                              body.commit_message)
            except GitError as exc:
                raise TransitionError(f"Merge failed: {exc}") from exc
            if body.delete_branch:
                await asyncio.to_thread(gitops.remove_worktree, repo, worktree, row["branch"])
        else:
            sha = uuid.uuid4().hex + uuid.uuid4().hex[:8]
        self._update(fid, status="merged", merged_commit=sha, finished_at=now_iso(),
                     **({"worktree_path": None} if body.delete_branch else {}))
        self.bus.emit(fid, "human", "gate", f"Merged · {sha[:7]}", {"gate": "merge",
                                                                     "approved": True})
        self.bus.emit(fid, "system", "status", f"Merged into {project['default_branch']}",
                      {"to": "merged", "sha": sha})
        if not body.follow_up_nits:
            return None
        nits = self.db.all("SELECT file, line, text FROM findings WHERE feature_id = ? "
                           "AND severity = 'Nit'", (fid,))
        if not nits:
            return None
        spec = "Address these non-blocking review nits:\n" + "\n".join(
            f"- {_where(n['file'], n['line'])}: {n['text']}" for n in nits)
        return self.create_feature(row["project_id"], f"Follow-up: nits from {row['title']}",
                                   spec)


def _where(file: str, line: int | None) -> str:
    return f"{file}:{line}" if line else file


def _task_path(task: Task) -> str:
    return f"tasks/{task.seq:03d}-{gitops.slugify(task.title)}.md"


def _task_md(task: Task, row: sqlite3.Row) -> str:
    criteria = "\n".join(f"- [ ] {c}" for c in task.acceptance_criteria)
    return (f"---\nstatus: pending\nfeature: {row['slug']}\nkind: {task.kind}\n---\n\n"
            f"# {task.title}\n\nLabel: {task.label or '-'}\n"
            f"Depends on: {task.depends_on or 'None'}\n\n## Scope\n\n{task.description}\n\n"
            f"## Acceptance Criteria\n\n{criteria}\n\n## Log\n")
