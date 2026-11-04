# Shortly

A tiny URL shortener (FastAPI, Python 3.11+, managed with uv).

## Commands

- Install: `uv sync`
- Tests: `uv run pytest -q`
- Lint: `uv run ruff check .`
- Run: `uv run uvicorn app.main:app --reload`

## Conventions

- Keep modules small: HTTP in `app/main.py`, storage in `app/store.py`, new concerns in new modules.
- Every behaviour change ships with tests in `tests/`.
- Storage is in memory for now; don't add a database.
