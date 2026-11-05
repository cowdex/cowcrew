from cowcrew.plans import PLANS


def test_every_plan_gives_the_same_value_per_dollar() -> None:
    per_dollar = {k: p.weekly_value_usd / p.price_month for k, p in PLANS.items()}
    assert set(per_dollar.values()) == {12.0}


def test_real_cost_of_a_run_on_max() -> None:
    plan = PLANS["max"]
    # A feature worth $19.43 at API prices uses ~1.6% of Max's weekly allowance.
    assert round(plan.used_pct(19.43), 1) == 1.6
    assert round(plan.real_cost(19.43), 2) == 0.37
    assert round(plan.real_cost(plan.weekly_value_usd), 2) == round(plan.price_week, 2)


def test_overview_shows_plan_cost(make_state) -> None:
    from fastapi.testclient import TestClient

    from cowcrew.main import create_app

    with TestClient(create_app(make_state(billing="subscription"))) as client:
        assert client.get("/api/settings").json()["plan"] is None
        client.put("/api/settings", json={"plan": "max"})
        assert client.get("/api/settings").json()["plan"] == "max"
        spend = client.get("/api/overview").json()["spend"]
        assert spend["plan"] == "Max" and spend["plan_week_usd"] == 23.08
        assert spend["plan_cost_usd"] == 0.0
