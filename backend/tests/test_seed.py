"""Seed data produces a coherent, lively Overview and is never driven automatically."""

from __future__ import annotations

from collections.abc import Callable

from fastapi.testclient import TestClient

from cowcrew.api import AppState
from cowcrew.main import create_app
from cowcrew.models import FeatureDetail, Overview
from cowcrew.seed import seed


def test_seed_overview(make_state: Callable[..., AppState]) -> None:
    state = make_state()
    project_id = seed(state.db, state.bus)
    seed(state.db, state.bus)  # idempotent: replaces the previous demo project
    with TestClient(create_app(state)) as client:
        overview = Overview.model_validate(client.get("/api/overview").json())
        scoped = client.get("/api/overview", params={"project_id": project_id + 1}).json()
        features = {f.title: f for f in overview.features}
        for f in overview.features:
            FeatureDetail.model_validate(client.get(f"/api/features/{f.id}").json())

    assert statuses_after_restart(make_state, state) == {f.id: f.status
                                                         for f in overview.features}
    assert scoped["features"] == [] or all(f["project_id"] == project_id + 1
                                           for f in scoped["features"])

    rate = features["Rate limiting for public API"]
    assert (rate.status, rate.tasks_done, rate.tasks_total) == ("building", 3, 7)
    assert rate.stage_text == "Build · task 4 of 7 · SWE ⇄ Tester"
    assert features["SSO with Google Workspace"].status == "awaiting_plan_approval"
    invoice = features["Invoice PDF export"]
    assert invoice.status == "awaiting_merge" and invoice.pr_number == 42
    assert features["Fix flaky checkout test"].stages[3] == "fail"
    assert features["Audit log export"].status == "merged"

    k = overview.kpis
    assert k.in_flight == 4 and k.waiting_on_you == 2 and k.ci_failing == 1
    assert k.committed_7d > 10 and 0 < k.first_try_pass_pct < 100
    assert 0 < k.spend_7d_usd < k.budget_usd
    assert len(overview.board) == 4
    assert overview.board[0].cells == ["done", "done", "done", "run", "pend", "pend", "pend"]
    assert {m.model for m in overview.spend.by_model} == {"opus", "fable", "sonnet"}
    assert abs(sum(m.pct for m in overview.spend.by_model) - 100) < 0.5
    assert overview.spend.wow_pct is not None and overview.spend.projected_usd > 0
    assert [t.key for t in overview.trends] == ["lead_time", "loops_per_task", "blockers_per_pr"]
    for trend in overview.trends:
        assert len(trend.points) == 12 and max(trend.points) == 1.0
        assert len(set(trend.points)) > 2, trend
    states = {a.key: a.state for a in overview.agents}
    assert states == {"product_architect": "waiting", "software_engineer": "working",
                      "tester": "queued", "pr_reviewer": "waiting",
                      "oncall_engineer": "working"}
    assert len(overview.activity) == 8
    assert all(e.kind in {"status", "handoff", "verdict", "gate", "error"}
               for e in overview.activity)
    assert [e.ts for e in overview.activity] == sorted((e.ts for e in overview.activity),
                                                       reverse=True)

    flaky = FeatureDetail.model_validate(
        _detail(state, features["Fix flaky checkout test"].id))
    assert flaky.ci_runs[0].diagnosis and flaky.ci_runs[0].failing_log
    invoice_detail = FeatureDetail.model_validate(_detail(state, invoice.id))
    assert [f.status for f in invoice_detail.findings if f.severity == "Blocker"] == ["fixed"]
    assert sum(f.severity == "Nit" for f in invoice_detail.findings) == 3
    assert all(item.ok for item in invoice_detail.checklist), invoice_detail.checklist


def statuses_after_restart(make_state: Callable[..., AppState],
                           state: AppState) -> dict[int, str]:
    """A fresh app on the same DB runs recovery; seeded features must stay untouched."""
    fresh = make_state()
    with TestClient(create_app(fresh)) as client:
        features = client.get("/api/features").json()
        assert not any(fresh.orchestrator.is_running(f["id"]) for f in features)
        return {f["id"]: f["status"] for f in features}


def _detail(state: AppState, fid: int) -> dict:
    with TestClient(create_app(state)) as client:
        return client.get(f"/api/features/{fid}").json()
