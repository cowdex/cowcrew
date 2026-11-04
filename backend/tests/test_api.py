"""HTTP + WebSocket smoke tests through the real FastAPI app."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from cowcrew.api import AppState
from cowcrew.main import create_app


@pytest.fixture
def client(make_state: Callable[..., AppState]) -> Iterator[TestClient]:
    with TestClient(create_app(make_state())) as c:
        yield c


def wait_for(client: TestClient, fid: int, status: str, timeout: float = 20) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        detail = client.get(f"/api/features/{fid}").json()
        if detail["feature"]["status"] == status:
            return detail
        time.sleep(0.05)
    raise AssertionError(f"feature never reached {status}: {detail['feature']['status']}")


def make_project(client: TestClient, repo: Path) -> int:
    res = client.post("/api/projects", json={"name": "orbit", "repo_path": str(repo)})
    assert res.status_code == 200, res.text
    return res.json()["id"]


def test_health_and_settings(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"ok": True, "version": "0.1.0"}
    settings = client.get("/api/settings").json()
    assert settings["simulate"] is True and settings["max_attempts"] == 4
    assert settings["models"]["software_engineer"] == "opus"
    updated = client.put("/api/settings", json={"budget_usd_week": 80, "max_attempts": 3,
                                                "models": {"tester": "haiku"}}).json()
    assert updated["budget_usd_week"] == 80 and updated["max_attempts"] == 3
    assert updated["models"]["tester"] == "haiku" and updated["models"]["pr_reviewer"] == "fable"
    assert client.put("/api/settings", json={"max_attempts": 0}).status_code == 422
    assert client.put("/api/settings", json={"simulate": False}).json()["simulate"] is True


def test_projects(client: TestClient, git_repo: Path, tmp_path: Path) -> None:
    bad = client.post("/api/projects", json={"name": "x", "repo_path": str(tmp_path)})
    assert bad.status_code == 400 and "not a git repository" in bad.json()["detail"]
    pid = make_project(client, git_repo)
    projects = client.get("/api/projects").json()
    assert projects[0]["default_branch"] == "main" and projects[0]["repo_path"] == str(git_repo)
    assert client.delete(f"/api/projects/{pid}").json() == {"ok": True}
    assert client.delete(f"/api/projects/{pid}").status_code == 404
    assert client.get("/api/projects").json() == []


def test_feature_flow_and_conflicts(client: TestClient, git_repo: Path) -> None:
    pid = make_project(client, git_repo)
    assert client.post("/api/features", json={"project_id": 999, "title": "x",
                                              "spec": "y"}).status_code == 404
    created = client.post("/api/features", json={"project_id": pid, "title": "Invoice export",
                                                  "spec": "Export invoices"})
    assert created.status_code == 200
    summary = created.json()
    assert summary["status"] == "grilling" and summary["stages"][0] == "run"
    fid = summary["id"]

    detail = wait_for(client, fid, "awaiting_answers")
    assert detail["feature"]["waiting_on_you"] is True
    conflict = client.post(f"/api/features/{fid}/approve")
    assert conflict.status_code == 409 and "awaiting_plan_approval" in conflict.json()["detail"]
    assert client.post(f"/api/features/{fid}/resume").status_code == 409

    answers = [{"id": q["id"], "answer": "yes"} for q in detail["questions"]]
    assert client.post(f"/api/features/{fid}/answers", json={"answers": answers}).status_code == 200
    detail = wait_for(client, fid, "awaiting_plan_approval")
    assert len(detail["tasks"]) == 4

    assert client.post(f"/api/features/{fid}/message", json={
        "agent": "software_engineer", "text": "prefer stdlib"}).json() == {"ok": True}
    assert client.post(f"/api/features/{fid}/message", json={
        "agent": "nobody", "text": "x"}).status_code == 422

    assert client.post(f"/api/features/{fid}/approve").status_code == 200
    detail = wait_for(client, fid, "awaiting_merge", timeout=60)
    assert detail["feature"]["tasks_done"] == detail["feature"]["tasks_total"] > 4
    assert detail["checklist"] and all(item["ok"] for item in detail["checklist"])

    events = client.get(f"/api/features/{fid}/events", params={"limit": 5}).json()
    assert len(events) == 5 and events[0]["id"] > events[-1]["id"]
    older = client.get(f"/api/features/{fid}/events",
                       params={"before_id": events[-1]["id"], "agent": "tester"}).json()
    assert older and all(e["agent"] == "tester" and e["id"] < events[-1]["id"] for e in older)

    listed = client.get("/api/features", params={"status": "awaiting_merge,merged"}).json()
    assert [f["id"] for f in listed] == [fid]
    assert client.get("/api/features", params={"status": "building"}).json() == []

    merged = client.post(f"/api/features/{fid}/merge", json={
        "commit_message": "feat: invoice export", "delete_branch": True,
        "follow_up_nits": False})
    assert merged.status_code == 200 and merged.json()["feature"]["status"] == "merged"
    assert client.post(f"/api/features/{fid}/merge", json={
        "commit_message": "again"}).status_code == 409
    assert client.get("/api/features/12345").status_code == 404


def test_websocket_streams_events_and_features(client: TestClient, git_repo: Path) -> None:
    pid = make_project(client, git_repo)
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json() == {"type": "hello", "version": "0.1.0"}
        client.post("/api/features", json={"project_id": pid, "title": "WS", "spec": "s"})
        seen: set[str] = set()
        for _ in range(20):
            message = ws.receive_json()
            seen.add(message["type"])
            if {"event", "feature"} <= seen:
                break
        assert {"event", "feature"} <= seen


def test_cross_site_requests_are_blocked(client: TestClient) -> None:
    evil = {"Origin": "https://evil.example"}
    assert client.put("/api/settings", json={"max_attempts": 2}, headers=evil).status_code == 403
    ok = client.put("/api/settings", json={"max_attempts": 2},
                    headers={"Origin": "http://localhost:5173"})
    assert ok.status_code == 200
    assert client.get("/api/health", headers={"Host": "attacker.example"}).status_code == 400
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws", headers=evil) as ws:
        ws.receive_json()
    cors = client.options("/api/settings", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "PUT"})
    assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_frontend_serving(make_state: Callable[..., AppState], tmp_path: Path) -> None:
    with TestClient(create_app(make_state())) as c:
        page = c.get("/")
        assert page.status_code == 200 and "make build" in page.text
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<div id=root></div>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    with TestClient(create_app(make_state(frontend_dist=dist))) as c:
        assert c.get("/features/3").text == "<div id=root></div>"
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert c.get("/../../etc/passwd").text == "<div id=root></div>"
        missing = c.get("/api/nope")
        assert missing.status_code == 404 and missing.json() == {"detail": "Not Found"}
