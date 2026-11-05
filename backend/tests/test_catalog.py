import io
import json

from cowcrew import catalog as cat


def test_builtin_list_without_api_key(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    c = cat.catalog(refresh=True)
    assert c.source == "builtin"
    ids = [m.id for m in c.models]
    assert ids[:4] == ["fable", "opus", "sonnet", "haiku"]
    assert "claude-opus-5-5" in ids


def test_live_list_with_api_key(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    payload = {"data": [
        {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5",
         "created_at": "2026-06-30"},
        {"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5",
         "created_at": "2026-10-01"},
    ]}
    seen = {}

    def fake_urlopen(req, timeout):
        seen["key"] = req.get_header("X-api-key")
        return io.BytesIO(json.dumps(payload).encode())

    monkeypatch.setattr(cat.urllib.request, "urlopen", fake_urlopen)
    c = cat.catalog(refresh=True)
    assert c.source == "anthropic" and seen["key"] == "sk-test"
    live = {m.id: m.group for m in c.models[4:]}
    assert live == {"claude-sonnet-5-5": "Current", "claude-sonnet-5": "Older"}


def test_falls_back_when_api_fails(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    def boom(req, timeout):
        raise cat.urllib.error.URLError("offline")

    monkeypatch.setattr(cat.urllib.request, "urlopen", boom)
    assert cat.catalog(refresh=True).source == "builtin"


def test_models_endpoint(make_state, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from cowcrew.main import create_app

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with TestClient(create_app(make_state())) as client:
        r = client.get("/api/models?refresh=true")
        assert r.status_code == 200
        assert r.json()["models"][0]["id"] == "fable"
