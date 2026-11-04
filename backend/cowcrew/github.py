"""GitHub integration through the `gh` CLI (push, PR, CI runs, merge), plus a simulated twin.

All methods are blocking; the orchestrator calls them in a worker thread.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from cowcrew.gitops import git

GH_TIMEOUT = 120
LOG_LIMIT = 6_000
FAILED = {"failure", "cancelled", "timed_out", "startup_failure", "action_required"}


class GitHubError(Exception):
    """A gh/git remote operation failed."""


@dataclass(frozen=True)
class Target:
    """Where CI operations apply."""

    feature_id: int
    cwd: Path | None  # the worktree, if one exists
    repo: str | None  # owner/name, if the project has a GitHub remote
    branch: str
    base: str


@dataclass
class CheckResult:
    """Aggregate CI state for one pushed commit. `run_ids` empty = no workflow runs found."""

    run_ids: list[str] = field(default_factory=list)
    status: str = "queued"  # queued | in_progress | success | failure
    jobs: list[dict[str, Any]] = field(default_factory=list)
    failing_job: str | None = None
    failing_run_id: str | None = None


class CIProvider(Protocol):
    def push(self, t: Target) -> None: ...
    def ensure_pr(self, t: Target, title: str, body: str) -> tuple[int | None, str | None]: ...
    def check(self, t: Target, head_sha: str) -> CheckResult: ...
    def failed_log(self, t: Target, run_id: str) -> str: ...
    def merge_pr(self, t: Target, number: int, subject: str, delete_branch: bool) -> str: ...


def _gh(cwd: Path | None, *args: str) -> str:
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"}
    try:
        proc = subprocess.run(
            ["gh", *args], cwd=str(cwd) if cwd else None, capture_output=True, text=True,
            timeout=GH_TIMEOUT, env=env, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitHubError(f"gh {args[0]} failed: {exc}") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        raise GitHubError(f"gh {' '.join(args[:2])} failed: {detail[-1] if detail else 'error'}")
    return proc.stdout.strip()


def _seconds(start: str | None, end: str | None) -> int | None:
    if not start or not end or start.startswith("0001"):
        return None
    try:
        delta = datetime.fromisoformat(end.replace("Z", "+00:00")) - datetime.fromisoformat(
            start.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, int(delta.total_seconds()))


def _job_conclusion(job: dict[str, Any]) -> str:
    if job.get("status") != "completed":
        return "in_progress" if job.get("status") == "in_progress" else "queued"
    conclusion = job.get("conclusion") or ""
    if conclusion in FAILED:
        return "failure"
    return "skipped" if conclusion in {"skipped", "neutral"} else "success"


class GhCli:
    """Real GitHub via `gh`."""

    def push(self, t: Target) -> None:
        if t.cwd is None:
            raise GitHubError("no worktree to push from")
        git(t.cwd, "push", "-u", "origin", t.branch)

    def ensure_pr(self, t: Target, title: str, body: str) -> tuple[int | None, str | None]:
        assert t.repo
        existing = json.loads(_gh(t.cwd, "pr", "list", "-R", t.repo, "--head", t.branch,
                                  "--state", "open", "--json", "number,url") or "[]")
        if existing:
            return int(existing[0]["number"]), str(existing[0]["url"])
        url = _gh(t.cwd, "pr", "create", "-R", t.repo, "--head", t.branch, "--base", t.base,
                  "--title", title, "--body", body)
        match = re.search(r"/pull/(\d+)", url)
        return (int(match.group(1)) if match else None), url.splitlines()[-1]

    def check(self, t: Target, head_sha: str) -> CheckResult:
        assert t.repo
        runs = json.loads(_gh(t.cwd, "run", "list", "-R", t.repo, "--branch", t.branch,
                              "--limit", "20", "--json",
                              "databaseId,status,conclusion,headSha,workflowName") or "[]")
        runs = [r for r in runs if r.get("headSha") == head_sha]
        result = CheckResult(run_ids=[str(r["databaseId"]) for r in runs])
        if not runs:
            return result
        for run in runs:
            view = json.loads(_gh(t.cwd, "run", "view", str(run["databaseId"]), "-R", t.repo,
                                  "--json", "jobs") or "{}")
            for job in view.get("jobs", []):
                conclusion = _job_conclusion(job)
                result.jobs.append({"name": job.get("name", "job"), "conclusion": conclusion,
                                    "duration_seconds": _seconds(job.get("startedAt"),
                                                                 job.get("completedAt"))})
                if conclusion == "failure" and result.failing_job is None:
                    result.failing_job = job.get("name")
                    result.failing_run_id = str(run["databaseId"])
        statuses = [r.get("status") for r in runs]
        conclusions = [r.get("conclusion") for r in runs]
        if any(c in FAILED for c in conclusions) or result.failing_job:
            result.status = "failure"
            if result.failing_run_id is None:
                result.failing_run_id = str(runs[0]["databaseId"])
        elif any(s != "completed" for s in statuses):
            result.status = "in_progress" if "in_progress" in statuses else "queued"
        else:
            result.status = "success"
        return result

    def failed_log(self, t: Target, run_id: str) -> str:
        assert t.repo
        return _gh(t.cwd, "run", "view", run_id, "-R", t.repo, "--log-failed")[-LOG_LIMIT:]

    def merge_pr(self, t: Target, number: int, subject: str, delete_branch: bool) -> str:
        assert t.repo
        args = ["pr", "merge", str(number), "-R", t.repo, "--squash", "--subject", subject]
        _gh(None, *args, *(["--delete-branch"] if delete_branch else []))
        return _gh(None, "pr", "view", str(number), "-R", t.repo, "--json", "mergeCommit",
                   "-q", ".mergeCommit.oid")


SIM_LOG = """\
=========================== FAILURES ===========================
___________ test_checkout_total_is_stable[random-order] ___________

    def test_checkout_total_is_stable(cart_fixture):
        totals = [line.total for line in cart_fixture.lines]
>       assert totals == [12.5, 7.0, 3.25]
E       AssertionError: assert [7.0, 12.5, 3.25] == [12.5, 7.0, 3.25]

tests/unit/test_checkout.py:58: AssertionError
FAILED tests/unit/test_checkout.py::test_checkout_total_is_stable - AssertionError
==================== 1 failed, 211 passed in 41.27s ====================
Error: Process completed with exit code 1."""


class SimulatedCI:
    """Demo CI: the first pushed commit goes red, later commits go green; nothing leaves the box."""

    def __init__(self) -> None:
        self._first_sha: dict[int, str] = {}
        self._polls: dict[tuple[int, str], int] = {}

    def push(self, t: Target) -> None:
        return None

    def ensure_pr(self, t: Target, title: str, body: str) -> tuple[int | None, str | None]:
        if not t.repo:
            return None, None
        number = 40 + t.feature_id
        return number, f"https://github.com/{t.repo}/pull/{number}"

    def check(self, t: Target, head_sha: str) -> CheckResult:
        first = self._first_sha.setdefault(t.feature_id, head_sha)
        polls = self._polls.get((t.feature_id, head_sha), 0) + 1
        self._polls[(t.feature_id, head_sha)] = polls
        run_id = f"sim-{t.feature_id}-{head_sha[:7]}"
        lint = {"name": "lint", "conclusion": "success", "duration_seconds": 38}
        if polls == 1:
            return CheckResult([run_id], "in_progress", [
                lint, {"name": "unit-tests", "conclusion": "in_progress", "duration_seconds": None},
            ])
        if head_sha == first:
            return CheckResult([run_id], "failure", [
                lint, {"name": "unit-tests", "conclusion": "failure", "duration_seconds": 212},
                {"name": "build", "conclusion": "skipped", "duration_seconds": None},
            ], failing_job="unit-tests", failing_run_id=run_id)
        return CheckResult([run_id], "success", [
            lint, {"name": "unit-tests", "conclusion": "success", "duration_seconds": 204},
            {"name": "build", "conclusion": "success", "duration_seconds": 95},
        ])

    def failed_log(self, t: Target, run_id: str) -> str:
        return SIM_LOG

    def merge_pr(self, t: Target, number: int, subject: str, delete_branch: bool) -> str:
        return f"{abs(hash((t.feature_id, subject))):040x}"[:40]
