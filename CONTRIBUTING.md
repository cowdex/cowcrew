# Contributing to CowCrew

Thanks for helping build the factory. 🐮

## Set up

```bash
git clone https://github.com/cowdex/cowcrew && cd cowcrew
make install   # backend (uv) and frontend (npm) dependencies
make dev       # backend on :8787 with reload, Vite on :5173
```

`make demo` runs everything with simulated agents, so you don't need an API key to work on the
dashboard or the orchestrator.

## Before you open a pull request

- `make test` passes (backend tests and ruff).
- `cd frontend && npm run typecheck && npm run lint && npm run build` passes.
- New behaviour comes with tests in `backend/tests/`.
- Keep pull requests small and focused on one change.

## Good first contributions

- A new agent role or a review checklist for a stack you know well.
- Support for another CI provider next to GitHub Actions.
- Dashboard improvements: charts, filters, accessibility.
- Docs: a walkthrough of CowCrew on your own project.

## Security

Please don't open public issues for security problems. See [SECURITY.md](SECURITY.md).
