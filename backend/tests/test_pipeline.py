"""A full simulated feature run on a real temporary git repo, create → merge."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from cowcrew.api import AppState
from cowcrew.models import MergeBody
from cowcrew.store import detail_of
from tests.conftest import add_project, run_git


async def test_full_simulated_feature(make_state: Callable[..., AppState], git_repo: Path) -> None:
    state = make_state()
    orch, db = state.orchestrator, state.db
    project_id = add_project(state, git_repo)

    fid = orch.create_feature(project_id, "Rate limiting for public API", "Limit /v1 by key.")
    await orch.wait_idle(fid)
    detail = detail_of(db, orch._row(fid))
    assert detail.feature.status == "awaiting_answers"
    assert detail.feature.waiting_on_you
    assert len(detail.questions) == 3

    orch.answer(fid, {q.id: "Yes" for q in detail.questions})
    await orch.wait_idle(fid)
    detail = detail_of(db, orch._row(fid))
    assert detail.feature.status == "awaiting_plan_approval"
    assert len(detail.tasks) == 4 and detail.feature.adr is not None

    orch.approve(fid)
    await orch.wait_idle(fid)
    detail = detail_of(db, orch._row(fid))
    f = detail.feature
    assert f.status == "awaiting_merge", [e["message"] for e in _errors(state, fid)]
    assert f.branch == "feat/rate-limiting-for-public-api"
    worktree = Path(f.worktree_path or "")
    assert worktree == git_repo.parent / "orbit-rate-limiting-for-public-api"
    assert len(list((worktree / "tasks").glob("*.md"))) == len(detail.tasks)
    assert any((worktree / "docs" / "adr").glob("0001-*.md"))

    # Tester failed task 2 once, then passed.
    assert [t.attempts for t in detail.tasks if t.kind == "plan"] == [1, 2, 1, 1]
    # Review round 1 raised a Blocker (fixed by a rollup), CI went red once (fix task), then green.
    kinds = [t.kind for t in detail.tasks]
    assert kinds.count("rollup") == 1 and kinds.count("fix") == 1
    assert all(t.status == "committed" and t.commit_sha for t in detail.tasks)
    assert [r.status for r in detail.ci_runs] == ["failure", "success"]
    assert detail.ci_runs[0].diagnosis is not None and detail.ci_runs[0].failing_log
    blockers = [x for x in detail.findings if x.severity == "Blocker"]
    assert blockers and all(b.status == "fixed" for b in blockers)
    assert detail.acceptance and detail.acceptance.verdict == "ACCEPT"
    assert all(item.ok for item in detail.checklist), detail.checklist
    assert f.cost_usd > 0 and f.tool_calls > 0 and f.tokens_in > 0
    assert f.stages == ["done", "done", "done", "done", "wait"]

    log = run_git(worktree, "log", "--format=%s", "main..HEAD").splitlines()
    assert log[-1] == "chore(plan): Rate limiting for public API"
    assert "feat(rate-limiting-for-public-api): Core rate limiting logic (task 002)" in log
    assert len(log) == 1 + len(detail.tasks)

    follow_up = await orch.merge(fid, MergeBody(commit_message="feat: rate limiting",
                                                delete_branch=True, follow_up_nits=True))
    detail = detail_of(db, orch._row(fid))
    assert detail.feature.status == "merged"
    assert run_git(git_repo, "log", "-1", "--format=%s") == "feat: rate limiting"
    assert detail.feature.merged_commit == run_git(git_repo, "rev-parse", "HEAD")
    assert (git_repo / "tasks").is_dir()
    assert not worktree.exists()
    assert "feat/rate-limiting-for-public-api" not in run_git(git_repo, "branch")

    assert follow_up is not None
    nits_feature = orch._row(follow_up)
    assert nits_feature["title"] == "Follow-up: nits from Rate limiting for public API"
    assert "naming" in nits_feature["spec"]
    await orch.shutdown()


def _errors(state: AppState, fid: int) -> list[dict]:
    return [dict(r) for r in state.db.all(
        "SELECT message FROM events WHERE feature_id = ? AND kind = 'error'", (fid,))]


async def test_merge_refuses_dirty_main_checkout(make_state: Callable[..., AppState],
                                                 git_repo: Path) -> None:
    from cowcrew.orchestrator import TransitionError

    state = make_state()
    orch = state.orchestrator
    fid = orch.create_feature(add_project(state, git_repo), "Tiny change", "Do it.")
    await orch.wait_idle(fid)
    orch.answer(fid, {q["id"]: "ok" for q in state.db.all(
        "SELECT id FROM questions WHERE feature_id = ?", (fid,))})
    await orch.wait_idle(fid)
    orch.approve(fid)
    await orch.wait_idle(fid)
    assert orch._row(fid)["status"] == "awaiting_merge"
    (git_repo / "README.md").write_text("dirty\n")
    try:
        await orch.merge(fid, MergeBody(commit_message="x"))
    except TransitionError as exc:
        assert "uncommitted" in str(exc)
    else:
        raise AssertionError("merge should refuse a dirty checkout")
    assert orch._row(fid)["status"] == "awaiting_merge"


async def _to_merge_gate(state: AppState, project_id: int, title: str = "Tiny change") -> int:
    orch = state.orchestrator
    fid = orch.create_feature(project_id, title, "Do it.")
    await orch.wait_idle(fid)
    orch.answer(fid, {q["id"]: "ok" for q in state.db.all(
        "SELECT id FROM questions WHERE feature_id = ?", (fid,))})
    await orch.wait_idle(fid)
    orch.approve(fid)
    await orch.wait_idle(fid)
    assert orch._row(fid)["status"] == "awaiting_merge", _errors(state, fid)
    return fid


async def test_simulated_run_with_github_repo_merges_locally(
        make_state: Callable[..., AppState], git_repo: Path) -> None:
    """A fake PR number must never route a simulated run to the remote merge path."""
    state = make_state()
    orch = state.orchestrator
    fid = await _to_merge_gate(state, add_project(state, git_repo, github_repo="me/orbit"))
    row = orch._row(fid)
    assert row["pr_number"]  # the simulated CI handed out a fake PR
    before = run_git(git_repo, "rev-parse", "HEAD")
    await orch.merge(fid, MergeBody(commit_message="feat: tiny", delete_branch=True))
    assert orch._row(fid)["status"] == "merged"
    assert run_git(git_repo, "rev-parse", "HEAD") != before
    assert run_git(git_repo, "log", "-1", "--format=%s") == "feat: tiny"
    assert orch._row(fid)["merged_commit"] == run_git(git_repo, "rev-parse", "HEAD")
    assert row["branch"] not in run_git(git_repo, "branch")
    await orch.shutdown()


async def test_ci_fix_goes_back_through_acceptance_and_review(
        make_state: Callable[..., AppState], git_repo: Path) -> None:
    state = make_state()
    orch, db = state.orchestrator, state.db
    fid = await _to_merge_gate(state, add_project(state, git_repo))
    ci_red = db.scalar("SELECT max(id) FROM events WHERE feature_id = ? AND "
                       "agent = 'oncall_engineer' AND message LIKE 'CI red%'", (fid,))
    last_accept = db.scalar("SELECT max(id) FROM events WHERE feature_id = ? AND "
                            "agent = 'product_architect' AND kind = 'verdict'", (fid,))
    last_review = db.scalar("SELECT max(id) FROM events WHERE feature_id = ? AND "
                            "agent = 'pr_reviewer' AND kind = 'verdict'", (fid,))
    assert ci_red is not None
    assert last_accept > ci_red and last_review > ci_red
    row = orch._row(fid)
    assert row["verified_sha"] == run_git(Path(row["worktree_path"]), "rev-parse", "HEAD")
    await orch.shutdown()


async def test_merge_refuses_commits_pushed_after_review(
        make_state: Callable[..., AppState], git_repo: Path) -> None:
    from cowcrew.orchestrator import TransitionError

    state = make_state()
    orch = state.orchestrator
    fid = await _to_merge_gate(state, add_project(state, git_repo))
    worktree = Path(orch._row(fid)["worktree_path"])
    (worktree / "sneaky.py").write_text("print('unreviewed')\n")
    run_git(worktree, "add", "sneaky.py")
    run_git(worktree, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-m", "sneaky")
    before = run_git(git_repo, "rev-parse", "HEAD")
    try:
        await orch.merge(fid, MergeBody(commit_message="x"))
    except TransitionError as exc:
        assert "moved after review" in str(exc)
    else:
        raise AssertionError("merge should refuse unreviewed commits")
    assert orch._row(fid)["status"] == "awaiting_merge"
    assert run_git(git_repo, "rev-parse", "HEAD") == before
    await orch.shutdown()
