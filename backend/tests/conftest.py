"""Shared fixtures: an isolated config, a temp git repo, app state and a scripted runner."""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from cowcrew.agents.runner import AgentJob, BaseRunner, RunRecorder
from cowcrew.api import AppState
from cowcrew.main import build_state
from cowcrew.settings import Config


def run_git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                          text=True).stdout.strip()


@pytest.fixture
def config(tmp_path: Path) -> Config:
    return Config(home=tmp_path / "home", simulate=True, has_credentials=False,
                  frontend_dist=tmp_path / "dist", sim_speed=0, ci_poll_seconds=0,
                  ci_timeout_seconds=30, ci_no_runs_grace_seconds=0)


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "orbit"
    repo.mkdir()
    run_git(repo, "init", "-q", "-b", "main")
    run_git(repo, "config", "user.email", "dev@example.com")
    run_git(repo, "config", "user.name", "Dev")
    (repo / "README.md").write_text("# orbit\n")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "init")
    return repo


class ScriptedRunner(BaseRunner):
    """Returns queued outputs per phase (the last one repeats); callables get the job."""

    script: dict[str, list[Any]]
    jobs: list[AgentJob]

    async def _execute(self, job: AgentJob, model: str, rec: RunRecorder) -> Any:
        self.jobs.append(job)
        queue = self.script[job.phase]
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        output = item(job) if callable(item) else item
        rec.text(f"{job.phase} done")
        rec.tool("Read", {"file_path": str(job.cwd / "README.md")})
        rec.result(0.01, {"input_tokens": 100, "output_tokens": 10}, num_turns=1)
        return job.output.model_validate(output)


@pytest.fixture
def make_state(config: Config) -> Callable[..., AppState]:
    """Build app state; with a script, agents are a ScriptedRunner instead of the simulator."""

    def factory(script: dict[str, list[Any]] | None = None, **overrides: Any) -> AppState:
        def scripted(db: Any, bus: Any, settings: Any) -> ScriptedRunner:
            runner = ScriptedRunner(db, bus, settings)
            runner.script = script or {}
            runner.jobs = []
            return runner

        return build_state(replace(config, **overrides),
                           runner_factory=scripted if script is not None else None)

    return factory


def add_project(state: AppState, repo: Path | str, github_repo: str | None = None) -> int:
    return state.db.insert("projects", name="orbit", repo_path=str(repo), default_branch="main",
                           github_repo=github_repo, created_at="2026-01-01T00:00:00Z")
