def test_overview_shows_plan_cost(make_state) -> None:
    from fastapi.testclient import TestClient

    from cowcrew.main import create_app

    with TestClient(create_app(make_state(billing="subscription"))) as client:
        assert client.get("/api/settings").json()["plan"] is None
        client.put("/api/settings", json={"plan": "max"})
        assert client.get("/api/settings").json()["plan"] == "max"
        spend = client.get("/api/overview").json()["spend"]
        assert spend["plan"] == "Max" and spend["plan_week_usd"] == 23.08
        assert spend["plan_cost_usd"] == [0.0, 0.0]


def test_overview_splits_usage_per_project(make_state, git_repo) -> None:
    from fastapi.testclient import TestClient

    from cowcrew.main import create_app
    from tests.conftest import add_project

    state = make_state(billing="subscription")
    pid = add_project(state, git_repo)
    fid = state.db.insert("features", project_id=pid, title="Click stats", spec="x",
                          status="merged", slug="click-stats", created_at="2026-01-01T00:00:00Z",
                          updated_at="2026-01-01T00:00:00Z")
    from datetime import UTC, datetime

    from cowcrew.db import to_iso
    state.db.insert("events", feature_id=fid, agent="software_engineer", kind="cost",
                    message="cost", ts=to_iso(datetime.now(UTC)),
                    data='{"cost_usd": 19.43, "input_tokens": 1000000, "output_tokens": 200000}')
    with TestClient(create_app(state)) as client:
        client.put("/api/settings", json={"plan": "max"})
        lo, hi = client.get("/api/settings").json()["plan_usd_per_api_usd"]
        assert round(lo, 4) == 0.0192 and round(hi, 4) == 0.0298
        spend = client.get("/api/overview").json()["spend"]
    assert spend["by_project"][0]["name"] == "orbit"
    assert spend["by_project"][0]["usd"] == 19.43 and spend["by_project"][0]["tokens"] == 1200000
    assert spend["month_usd"] == 19.43
