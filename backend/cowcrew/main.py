"""FastAPI application: /api, /ws, and the built frontend at / (SPA fallback)."""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from cowcrew import __version__, store
from cowcrew.agents.runner import AgentRunner, BaseRunner, SimulatedRunner
from cowcrew.api import AppState, router
from cowcrew.db import Database
from cowcrew.events import EventBus
from cowcrew.github import CIProvider, GhCli, SimulatedCI
from cowcrew.orchestrator import Orchestrator, TransitionError
from cowcrew.overview import spend_since_days
from cowcrew.settings import Config, SettingsStore

DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1", "testserver"]
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

MISSING_DIST = """<!doctype html><html><head><meta charset="utf-8"><title>CowCrew</title>
<style>body{font:16px system-ui;margin:4rem auto;max-width:36rem;color:#222}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}</style></head>
<body><h1>CowCrew backend is running</h1>
<p>The web UI has not been built yet. Run <code>make build</code> at the repository root,
then reload this page. For development, run <code>make dev</code> and open
<a href="http://localhost:5173">localhost:5173</a>.</p>
<p>API health: <a href="/api/health">/api/health</a></p></body></html>"""


RunnerFactory = Callable[[Database, EventBus, SettingsStore], BaseRunner]


def build_state(
    config: Config, runner_factory: RunnerFactory | None = None, ci: CIProvider | None = None,
) -> AppState:
    """Wire database, event bus, settings, runner, CI provider and orchestrator together."""
    db = Database(config.db_path)
    bus = EventBus(db)
    bus.summary_of = lambda fid: store.summary_by_id(db, fid)
    settings = SettingsStore(db, config)
    runner: BaseRunner
    if runner_factory is not None:
        runner = runner_factory(db, bus, settings)
    else:
        if config.simulate:
            runner = SimulatedRunner(db, bus, settings, speed=config.sim_speed)
        else:
            runner = AgentRunner(
                db, bus, settings,
                remaining_budget=lambda: settings.budget_usd_week - spend_since_days(db, 7))
    ci = ci or (SimulatedCI() if config.simulate else GhCli())
    orchestrator = Orchestrator(db, bus, runner, settings, config, ci)
    return AppState(config, db, bus, settings, runner, orchestrator)


def origin_allowed(headers: Mapping[str, str]) -> bool:
    """Same-origin or the Vite dev server; requests without an Origin (curl, CLI) pass."""
    origin = headers.get("origin")
    if not origin or origin in DEV_ORIGINS:
        return True
    return urlsplit(origin).netloc == headers.get("host", "")


def create_app(state: AppState | None = None) -> FastAPI:
    state = state or build_state(Config.from_env())

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        state.bus.bind_loop(asyncio.get_running_loop())
        state.orchestrator.recover()
        yield
        await state.orchestrator.shutdown()

    app = FastAPI(title="CowCrew", version=__version__, lifespan=lifespan)
    app.state.cowcrew = state
    extra_hosts = [h for h in os.environ.get("COWCREW_ALLOWED_HOSTS", "").split(",") if h]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=LOOPBACK_HOSTS + extra_hosts)
    app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "DELETE"],
                       allow_headers=["Content-Type"])

    @app.middleware("http")
    async def csrf_guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Block cross-site state changes (a local server is reachable from any web page)."""
        if request.method in UNSAFE_METHODS and not origin_allowed(request.headers):
            return JSONResponse({"detail": "Cross-origin request blocked"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(TransitionError)
    async def on_transition_error(_request: Request, exc: TransitionError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    app.include_router(router)

    @app.websocket("/ws")
    async def websocket(ws: WebSocket) -> None:
        if not origin_allowed(ws.headers):
            await ws.close(code=1008)
            return
        await ws.accept()
        queue = state.bus.subscribe()
        receiver = asyncio.create_task(_until_disconnect(ws))
        try:
            await ws.send_json({"type": "hello", "version": __version__})
            while True:
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait({getter, receiver},
                                             return_when=asyncio.FIRST_COMPLETED)
                if getter not in done:
                    getter.cancel()
                    break
                await ws.send_json(getter.result())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            state.bus.unsubscribe(queue)
            receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await receiver

    dist = state.config.frontend_dist

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str) -> Response:
        if path.startswith(("api/", "ws")) or path == "api":
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        index = dist / "index.html"
        if not index.is_file():
            return HTMLResponse(MISSING_DIST)
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(index)

    return app


async def _until_disconnect(ws: WebSocket) -> None:
    """Drain client frames until the socket closes (the client never needs to send)."""
    while True:
        message = await ws.receive()
        if message["type"] == "websocket.disconnect":
            return

