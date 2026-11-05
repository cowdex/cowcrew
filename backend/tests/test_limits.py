from datetime import UTC, datetime

from cowcrew import limits


def test_records_latest_value_per_window(make_state) -> None:
    db = make_state().db
    soon = int(datetime.now(UTC).timestamp()) + 3600
    limits.record(db, {"rateLimitType": "seven_day", "utilization": 0.4, "status": "allowed",
                       "resetsAt": soon})
    limits.record(db, {"rateLimitType": "five_hour", "utilization": 0.9,
                       "status": "allowed_warning", "resetsAt": soon})
    limits.record(db, {"rateLimitType": "seven_day", "utilization": 0.62, "status": "allowed",
                       "resetsAt": soon})
    rows = limits.read(db)
    assert [r.kind for r in rows] == ["five_hour", "seven_day"]
    assert rows[1].used_pct == 62.0 and rows[0].status == "allowed_warning"


def test_window_that_has_reset_reads_as_zero(make_state) -> None:
    db = make_state().db
    limits.record(db, {"rateLimitType": "five_hour", "utilization": 1.0, "status": "rejected",
                       "resetsAt": 1})
    row = limits.read(db)[0]
    assert row.used_pct == 0.0 and row.status == "allowed" and row.resets_at is None


def test_overview_includes_limits(make_state) -> None:
    from fastapi.testclient import TestClient

    from cowcrew.main import create_app

    state = make_state(billing="subscription")
    limits.record(state.db, {"rateLimitType": "seven_day", "utilization": 0.5,
                             "status": "allowed", "resetsAt": 4_000_000_000})
    with TestClient(create_app(state)) as client:
        got = client.get("/api/overview").json()["limits"]
    assert got[0]["label"] == "Weekly · all models" and got[0]["used_pct"] == 50.0
