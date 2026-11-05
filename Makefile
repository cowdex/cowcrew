.PHONY: install dev build serve seed test demo reset app mac-app

BACKEND := backend
FRONTEND := frontend
PORT ?= 8787

install:
	cd $(BACKEND) && uv sync
	cd $(FRONTEND) && npm ci

# Backend with auto-reload on :8787 and Vite on :5173 (proxying /api and /ws). Ctrl+C stops both.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	(cd $(BACKEND) && uv run cowcrew serve --reload --port $(PORT)) & \
	(cd $(FRONTEND) && npm run dev) & \
	wait

build:
	cd $(FRONTEND) && npm run build

serve: build
	cd $(BACKEND) && uv run cowcrew serve --port $(PORT)

seed:
	cd $(BACKEND) && uv run cowcrew seed

reset:
	cd $(BACKEND) && uv run cowcrew reset

test:
	cd $(BACKEND) && uv run pytest -q && uv run ruff check .

# Demo data + simulated agents: no API key, no network, nothing pushed.
demo: build
	cd $(BACKEND) && COWCREW_SIMULATE=1 uv run cowcrew seed
	cd $(BACKEND) && COWCREW_SIMULATE=1 uv run cowcrew serve --port $(PORT)

# CowCrew in its own window (no browser tab).
app: build
	cd $(BACKEND) && uv run cowcrew app

# macOS: build CowCrew.app for the Dock/Launchpad (run once).
mac-app: build
	./scripts/make-mac-app.sh
