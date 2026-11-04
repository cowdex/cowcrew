from fastapi.testclient import TestClient

from app.main import app, store

client = TestClient(app)


def setup_function() -> None:
    store.links.clear()


def test_create_returns_code_and_short_url() -> None:
    res = client.post("/links", json={"url": "https://example.com/docs"})
    assert res.status_code == 201
    body = res.json()
    assert body["url"] == "https://example.com/docs"
    assert body["short_url"] == f"/{body['code']}"


def test_follow_redirects_to_target() -> None:
    code = client.post("/links", json={"url": "https://example.com"}).json()["code"]
    res = client.get(f"/{code}", follow_redirects=False)
    assert res.status_code == 307
    assert res.headers["location"] == "https://example.com"


def test_unknown_code_is_404() -> None:
    assert client.get("/nope", follow_redirects=False).status_code == 404


def test_codes_are_unique() -> None:
    codes = {
        client.post("/links", json={"url": f"https://e.com/{i}"}).json()["code"] for i in range(50)
    }
    assert len(codes) == 50


def test_missing_url_is_rejected() -> None:
    assert client.post("/links", json={}).status_code == 422
