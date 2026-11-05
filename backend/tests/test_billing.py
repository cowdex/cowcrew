"""Billing mode: subscription users see tokens, API users see dollars."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from cowcrew.api import AppState
from cowcrew.main import create_app
from cowcrew.settings import billing_mode


@pytest.mark.parametrize(("env", "creds", "expected"), [
    ({"ANTHROPIC_API_KEY": "sk-x"}, True, "api"),
    ({}, True, "subscription"),
    ({}, False, "api"),
    ({"COWCREW_BILLING": "subscription"}, False, "subscription"),
    ({"ANTHROPIC_API_KEY": "sk-x", "COWCREW_BILLING": "api"}, True, "api"),
])
def test_billing_mode(monkeypatch: pytest.MonkeyPatch, env: dict[str, str], creds: bool,
                      expected: str) -> None:
    for key in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                "COWCREW_BILLING"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert billing_mode(creds) == expected


def test_overview_reports_tokens_on_subscription(make_state: Callable[..., AppState]) -> None:
    state = make_state(billing="subscription")
    state.db.set_setting("budget_tokens_week", 10_000)
    state.bus.emit(None, "software_engineer", "cost", "run",
                   {"cost_usd": 2.5, "model": "opus", "input_tokens": 4_000,
                    "output_tokens": 1_000})
    with TestClient(create_app(state)) as client:
        settings = client.get("/api/settings").json()
        overview = client.get("/api/overview").json()
    assert settings["billing"] == "subscription" and settings["budget_tokens_week"] == 10_000
    spend = overview["spend"]
    assert spend["unit"] == "tokens" and spend["total_tokens"] == 5_000
    assert spend["budget_used_pct"] == 50.0
    assert spend["projected_tokens"] == 5_000  # no extrapolation from minutes of history
    assert overview["kpis"]["spend_7d_tokens"] == 5_000
    swe = next(a for a in overview["agents"] if a["key"] == "software_engineer")
    assert swe["spend_tokens"] == 5_000 and swe["spend_usd"] == 2.5


def test_overview_reports_dollars_on_api(make_state: Callable[..., AppState]) -> None:
    state = make_state()
    state.bus.emit(None, "tester", "cost", "run",
                   {"cost_usd": 3.0, "model": "sonnet", "input_tokens": 10, "output_tokens": 5})
    with TestClient(create_app(state)) as client:
        spend = client.get("/api/overview").json()["spend"]
    assert spend["unit"] == "usd" and spend["total_usd"] == 3.0
    assert spend["by_model"][0]["tokens"] == 15


def test_old_database_gains_verified_sha(tmp_path) -> None:
    import sqlite3

    from cowcrew.db import Database

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE features (id INTEGER PRIMARY KEY, title TEXT)")
    conn.commit()
    conn.close()
    db = Database(path)
    cols = {r["name"] for r in db.all("PRAGMA table_info(features)")}
    assert "verified_sha" in cols


def test_gh_merge_is_pinned_to_the_verified_commit(monkeypatch) -> None:
    from cowcrew import github

    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(github, "_gh", lambda cwd, *args: calls.append(args) or "abc")
    target = github.Target(feature_id=1, repo="me/orbit", cwd=None, branch="feat/x",
                           base="main")
    github.GhCli().merge_pr(target, 7, "feat: x", True, "deadbeef")
    merge = calls[0]
    assert merge[:2] == ("pr", "merge")
    assert merge[merge.index("--match-head-commit") + 1] == "deadbeef"
