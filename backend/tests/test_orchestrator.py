"""State machine transitions with a scripted runner: gates, retries, pause/resume, 409s."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from cowcrew.agents.runner import AgentError, AgentJob
from cowcrew.api import AppState
from cowcrew.models import MergeBody
from cowcrew.orchestrator import TransitionError
from cowcrew.store import detail_of
from tests.conftest import add_project

PLAN = {
    "tasks": [
        {"title": "First task", "description": "do one", "acceptance_criteria": ["one works"]},
        {"title": "Second task", "description": "do two", "acceptance_criteria": ["two works"],
         "depends_on": "001", "label": "api"},
    ],
    "adr": None, "glossary_terms": [],
    "estimate": {"hours_min": 1, "hours_max": 2, "cost_min": 1, "cost_max": 2, "files": 3},
}
SWE_OK = {"summary": "implemented", "files_changed": ["src/a.py"]}
PASS = {"verdict": "PASS", "tests_passed": 3, "tests_total": 3, "report": "all good"}
FAIL = {"verdict": "FAIL", "tests_passed": 2, "tests_total": 3, "report": "edge case breaks"}
ACCEPT = {"verdict": "ACCEPT", "summary": "good", "criteria": [{"text": "x", "met": True}],
          "issues": []}
REJECT = {"verdict": "REJECT", "summary": "copy unclear", "criteria": [],
          "issues": ["Error message says 'err' — say what to do"]}
CLEAN = {"findings": [{"severity": "Nit", "file": "a.py", "line": 3, "text": "naming"}]}


def script(**overrides: list[Any]) -> dict[str, list[Any]]:
    base: dict[str, list[Any]] = {
        "grill": [{"questions": []}], "groom": [PLAN], "implement": [SWE_OK], "test": [PASS],
        "accept": [ACCEPT], "review": [CLEAN], "diagnose": [{}],
    }
    return {**base, **overrides}


async def settle(state: AppState, fid: int) -> str:
    await state.orchestrator.wait_idle(fid)
    return state.orchestrator._row(fid)["status"]


@pytest.fixture
def real_mode(make_state: Callable[..., AppState]) -> Callable[..., AppState]:
    """Scripted agents with simulate off: no CI without a GitHub remote."""
    return lambda s: make_state(s, simulate=False)


async def test_zero_questions_go_straight_to_grooming(make_state: Callable[..., AppState],
                                                      git_repo: Path) -> None:
    state = make_state(script())
    fid = state.orchestrator.create_feature(add_project(state, git_repo), "Feature", "spec")
    assert await settle(state, fid) == "awaiting_plan_approval"
    messages = [r["message"] for r in state.db.all(
        "SELECT message FROM events WHERE feature_id = ? AND kind = 'status'", (fid,))]
    assert "No open questions — grooming the plan" in messages


async def test_illegal_transitions_raise(make_state: Callable[..., AppState],
                                         git_repo: Path) -> None:
    state = make_state(script(grill=[{"questions": ["Q1?"]}]))
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    assert await settle(state, fid) == "awaiting_answers"
    for action in (lambda: orch.approve(fid), lambda: orch.request_changes(fid, "x"),
                   lambda: orch.pause(fid), lambda: orch.resume(fid),
                   lambda: orch.send_back(fid, "x")):
        with pytest.raises(TransitionError):
            action()
    with pytest.raises(TransitionError):
        await orch.merge(fid, MergeBody(commit_message="x"))
    with pytest.raises(TransitionError):
        orch.answer(fid, {9999: "not mine"})


async def test_partial_answers_wait_for_the_rest(make_state: Callable[..., AppState],
                                                 git_repo: Path) -> None:
    state = make_state(script(grill=[{"questions": ["Q1?", "Q2?"]}]))
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    q1, q2 = (r["id"] for r in state.db.all("SELECT id FROM questions WHERE feature_id = ?",
                                            (fid,)))
    orch.answer(fid, {q1: "yes"})
    assert await settle(state, fid) == "awaiting_answers"
    orch.answer(fid, {q2: ""})
    assert await settle(state, fid) == "awaiting_plan_approval"
    groom_prompt = state.runner.jobs[-1].prompt
    assert "A: yes" in groom_prompt and "(no preference)" in groom_prompt


async def test_request_changes_regrooms_with_note(make_state: Callable[..., AppState],
                                                  git_repo: Path) -> None:
    state = make_state(script())
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.request_changes(fid, "Split the second task")
    assert await settle(state, fid) == "awaiting_plan_approval"
    assert "Split the second task" in state.runner.jobs[-1].prompt
    assert orch._row(fid)["change_note"] is None
    assert len(detail_of(state.db, orch._row(fid)).tasks) == 2


async def test_no_ci_without_github_goes_to_merge_gate(real_mode: Callable[..., AppState],
                                                       git_repo: Path) -> None:
    state = real_mode(script())
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.approve(fid)
    assert await settle(state, fid) == "awaiting_merge"
    detail = detail_of(state.db, orch._row(fid))
    ci_item = next(c for c in detail.checklist if "CI" in c.title)
    assert ci_item.title == "No CI configured" and ci_item.ok
    assert [f.status for f in detail.findings] == ["noted"]
    phases = [j.phase for j in state.runner.jobs]
    assert phases == ["grill", "groom", "implement", "test", "implement", "test", "accept",
                      "review"]
    swe, tester = state.runner.jobs[2], state.runner.jobs[3]
    assert swe.write_scope == "any" and "Edit" in swe.tools
    assert tester.write_scope == "tests" and "Edit" not in tester.tools
    assert all(j.write_scope == "none" for j in state.runner.jobs if j.agent != "software_engineer"
               and j.agent != "tester")


async def test_tester_fail_cap_pauses_then_resume_retries(real_mode: Callable[..., AppState],
                                                          git_repo: Path) -> None:
    state = real_mode(script(test=[FAIL, FAIL, PASS]))
    state.settings.db.set_setting("max_attempts", 2)
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.approve(fid)
    assert await settle(state, fid) == "paused"
    row = orch._row(fid)
    assert row["resume_status"] == "building"
    first = detail_of(state.db, row).tasks[0]
    assert first.status == "failed" and first.attempts == 2
    swe_prompts = [j.prompt for j in state.runner.jobs if j.phase == "implement"]
    assert "edge case breaks" in swe_prompts[1]
    errors = state.db.all("SELECT message FROM events WHERE feature_id = ? AND kind = 'error'",
                          (fid,))
    assert "failed QA 2 times" in errors[-1]["message"]

    orch.resume(fid)
    assert await settle(state, fid) == "awaiting_merge"
    tasks = detail_of(state.db, orch._row(fid)).tasks
    assert [t.status for t in tasks] == ["committed", "committed"]
    assert tasks[0].attempts == 1


async def test_pause_takes_effect_between_agent_runs(real_mode: Callable[..., AppState],
                                                     git_repo: Path) -> None:
    holder: dict[str, AppState] = {}

    def implement_then_pause(job: AgentJob) -> dict[str, Any]:
        holder["state"].orchestrator.pause(job.feature_id)
        return SWE_OK

    state = real_mode(script(implement=[implement_then_pause, SWE_OK]))
    holder["state"] = state
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.approve(fid)
    assert await settle(state, fid) == "paused"
    assert orch._row(fid)["resume_status"] == "building"
    task = detail_of(state.db, orch._row(fid)).tasks[0]
    assert task.status == "testing"
    assert [j.phase for j in state.runner.jobs][-1] == "implement"

    orch.resume(fid)
    assert await settle(state, fid) == "awaiting_merge"
    phases = [j.phase for j in state.runner.jobs]
    assert phases[3] == "test", "resume continues with the Tester, not a new SWE run"


async def test_acceptance_reject_creates_rollup(real_mode: Callable[..., AppState],
                                                git_repo: Path) -> None:
    state = real_mode(script(accept=[REJECT, ACCEPT]))
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.approve(fid)
    assert await settle(state, fid) == "awaiting_merge"
    tasks = detail_of(state.db, orch._row(fid)).tasks
    rollup = tasks[-1]
    assert rollup.kind == "rollup" and rollup.status == "committed"
    assert rollup.acceptance_criteria == REJECT["issues"]
    phases = [j.phase for j in state.runner.jobs]
    assert phases.count("accept") == 2


async def test_review_blockers_loop_and_get_fixed(real_mode: Callable[..., AppState],
                                                  git_repo: Path) -> None:
    blocker = {"findings": [{"severity": "Blocker", "file": "a.py", "line": 9,
                             "text": "untested branch"}]}
    state = real_mode(script(review=[blocker, CLEAN]))
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.approve(fid)
    assert await settle(state, fid) == "awaiting_merge"
    detail = detail_of(state.db, orch._row(fid))
    assert [(f.round, f.severity, f.status) for f in detail.findings] == [
        (1, "Blocker", "fixed"), (2, "Nit", "noted")]
    reviews = [j for j in state.runner.jobs if j.phase == "review"]
    assert "a.py: untested branch" in reviews[1].prompt
    assert orch._row(fid)["review_round"] == 2


async def test_review_round_cap_pauses(real_mode: Callable[..., AppState],
                                       git_repo: Path) -> None:
    blocker = {"findings": [{"severity": "Blocker", "file": "a.py", "text": "bug"}]}
    state = real_mode(script(review=[blocker]))
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.approve(fid)
    assert await settle(state, fid) == "paused"
    assert orch._row(fid)["review_round"] == 3


async def test_agent_error_pauses_with_error_event(real_mode: Callable[..., AppState],
                                                   git_repo: Path) -> None:
    state = real_mode(script(grill=[AgentError("agent returned no valid JSON result")]))
    fid = state.orchestrator.create_feature(add_project(state, git_repo), "Feature", "spec")
    assert await settle(state, fid) == "paused"
    assert state.orchestrator._row(fid)["resume_status"] == "grilling"
    last = state.db.one("SELECT * FROM events WHERE feature_id = ? ORDER BY id DESC", (fid,))
    assert last["kind"] == "error" and "no valid JSON" in last["message"]


async def test_human_message_reaches_next_prompt_once(real_mode: Callable[..., AppState],
                                                      git_repo: Path) -> None:
    state = real_mode(script())
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.message(fid, "software_engineer", "Use the existing retry helper")
    orch.approve(fid)
    await settle(state, fid)
    swe = [j.prompt for j in state.runner.jobs if j.phase == "implement"]
    assert "Use the existing retry helper" in swe[0]
    assert "Use the existing retry helper" not in swe[1]


async def test_budget_exhausted_pauses(real_mode: Callable[..., AppState],
                                       git_repo: Path) -> None:
    state = real_mode(script())
    state.db.set_setting("budget_usd_week", 1.0)
    state.bus.emit(None, "tester", "cost", "old run", {"cost_usd": 5.0, "model": "sonnet"})
    fid = state.orchestrator.create_feature(add_project(state, git_repo), "Feature", "spec")
    assert await settle(state, fid) == "paused"
    assert state.runner.jobs == []


async def test_recover_pauses_only_managed_running_features(
        make_state: Callable[..., AppState], git_repo: Path) -> None:
    state = make_state(script())
    project = add_project(state, git_repo)
    now = "2026-01-01T00:00:00Z"
    managed = state.db.insert("features", project_id=project, title="A", slug="a", spec="s",
                              status="building", created_at=now, updated_at=now)
    seeded = state.db.insert("features", project_id=project, title="B", slug="b", spec="s",
                             status="building", managed=0, created_at=now, updated_at=now)
    state.orchestrator.recover()
    assert state.orchestrator._row(managed)["status"] == "paused"
    assert state.orchestrator._row(managed)["resume_status"] == "building"
    assert state.orchestrator._row(seeded)["status"] == "building"
    assert not state.orchestrator.is_running(seeded)


async def test_stop_cancels_running_feature(make_state: Callable[..., AppState],
                                            git_repo: Path) -> None:
    state = make_state(sim_speed=1.0)
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await asyncio.sleep(0.05)
    assert orch.is_running(fid)
    orch.stop(fid)
    await asyncio.sleep(0)
    assert not orch.is_running(fid)
    row = orch._row(fid)
    assert row["status"] == "stopped" and row["finished_at"]
    with pytest.raises(TransitionError):
        orch.stop(fid)


async def test_send_back_queues_rollup_and_rebuilds(real_mode: Callable[..., AppState],
                                                    git_repo: Path) -> None:
    state = real_mode(script())
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Feature", "spec")
    await settle(state, fid)
    orch.approve(fid)
    await settle(state, fid)
    orch.send_back(fid, "Rename the endpoint to /v1/limits")
    assert await settle(state, fid) == "awaiting_merge"
    tasks = detail_of(state.db, orch._row(fid)).tasks
    assert tasks[-1].title.startswith("[Send-back]")
    assert tasks[-1].acceptance_criteria == ["Rename the endpoint to /v1/limits"]
    assert [j.phase for j in state.runner.jobs][-4:] == ["implement", "test", "accept", "review"]
