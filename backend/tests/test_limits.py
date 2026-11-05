import json
from datetime import UTC, datetime

from fastapi.testclient import TestClient

from cowcrew import limits
from cowcrew.main import create_app


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


def test_statusline_payload_and_daily_use(make_state) -> None:
    state = make_state(billing="subscription")
    resets = "2099-01-01T00:00:00Z"
    with TestClient(create_app(state)) as client:
        for pct in (10, 14, 21):
            r = client.post("/api/claude-usage/statusline", json={
                "five_hour": {"used_percentage": pct * 2, "resets_at": 4_000_000_000},
                "seven_day": {"used_percentage": pct, "resets_at": resets}})
            assert r.json() == {"stored": 2}
        usage = client.get("/api/claude-usage").json()
    by_kind = {x["kind"]: x for x in usage["limits"]}
    assert by_kind["seven_day"]["used_pct"] == 21.0
    assert by_kind["seven_day"]["source"] == "claude_code"
    assert by_kind["five_hour"]["label"] == "Current session"
    assert usage["daily"][-1]["weekly_pct"] == 11.0  # 10 -> 14 -> 21 today


def test_refresh_in_simulate_mode(make_state) -> None:
    with TestClient(create_app(make_state(billing="subscription"))) as client:
        usage = client.post("/api/claude-usage/refresh").json()
    assert {x["kind"] for x in usage["limits"]} == {"five_hour", "seven_day"}


def test_statusline_install_keeps_and_restores_previous(make_state, tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    settings = tmp_path / "claude" / "settings.json"
    settings.parent.mkdir()
    settings.write_text(json.dumps({"model": "opus", "statusLine": {"type": "command",
                                                                    "command": "my-line.sh"}}))
    home = tmp_path / "cowcrew"
    limits.install_statusline(home, "http://127.0.0.1:8787/api/claude-usage/statusline")
    data = json.loads(settings.read_text())
    assert "claude-statusline.py" in data["statusLine"]["command"] and data["model"] == "opus"
    assert limits.statusline_installed(home)
    # installing twice must not forget the user's own status line
    limits.install_statusline(home, "http://127.0.0.1:8787/api/claude-usage/statusline")
    limits.uninstall_statusline(home)
    data = json.loads(settings.read_text())
    assert data["statusLine"]["command"] == "my-line.sh" and data["model"] == "opus"
    assert not (home / "claude-statusline.py").exists()


def test_statusline_script_forwards_and_runs_previous(tmp_path, monkeypatch) -> None:
    import subprocess
    import sys

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    (tmp_path / "claude").mkdir()
    (tmp_path / "claude" / "settings.json").write_text(json.dumps(
        {"statusLine": {"type": "command", "command": "echo previous-line"}}))
    home = tmp_path / "cowcrew"
    limits.install_statusline(home, "http://127.0.0.1:9/unreachable")
    out = subprocess.run([sys.executable, str(home / "claude-statusline.py")],
                         input=json.dumps({"rate_limits": {"five_hour": {"used_percentage": 3}}}),
                         capture_output=True, text=True, timeout=10)
    assert out.stdout.strip() == "previous-line"
