"""REST routes under /api (see docs/CONTRACT.md)."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from cowcrew import __version__, gitops, limits
from cowcrew.agents.runner import BaseRunner
from cowcrew.catalog import ModelCatalog, catalog
from cowcrew.db import Database, now_iso
from cowcrew.events import EventBus, row_to_event
from cowcrew.models import (
    AnswersBody,
    Event,
    FeatureCreate,
    FeatureDetail,
    FeatureSummary,
    MergeBody,
    MessageBody,
    NoteBody,
    Overview,
    Project,
    ProjectCreate,
    Settings,
    SettingsUpdate,
)
from cowcrew.orchestrator import Orchestrator
from cowcrew.overview import build_overview
from cowcrew.plans import PLANS
from cowcrew.settings import Config, SettingsStore
from cowcrew.store import detail_of, project_of, summary_of


@dataclass
class AppState:
    config: Config
    db: Database
    bus: EventBus
    settings: SettingsStore
    runner: BaseRunner
    orchestrator: Orchestrator


def get_state(request: Request) -> AppState:
    return request.app.state.cowcrew


State = Annotated[AppState, Depends(get_state)]
router = APIRouter(prefix="/api")


def _feature(state: AppState, feature_id: int) -> sqlite3.Row:
    row = state.db.one("SELECT * FROM features WHERE id = ?", (feature_id,))
    if row is None:
        raise HTTPException(404, "Feature not found")
    return row


def _detail(state: AppState, feature_id: int) -> FeatureDetail:
    return detail_of(state.db, _feature(state, feature_id))


@router.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__}


# ----------------------------------------------------------------------------- projects


@router.get("/projects")
def list_projects(state: State) -> list[Project]:
    return [project_of(r) for r in state.db.all("SELECT * FROM projects ORDER BY id")]


@router.post("/projects")
def create_project(body: ProjectCreate, state: State) -> Project:
    repo = Path(body.repo_path).expanduser().resolve()
    if not gitops.is_git_repo(repo):
        raise HTTPException(400, f"{repo} is not a git repository")
    top = Path(gitops.git(repo, "rev-parse", "--show-toplevel"))
    project_id = state.db.insert(
        "projects", name=body.name.strip(), repo_path=str(top),
        default_branch=gitops.default_branch(top), github_repo=body.github_repo,
        created_at=now_iso())
    row = state.db.one("SELECT * FROM projects WHERE id = ?", (project_id,))
    assert row is not None
    return project_of(row)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, state: State) -> dict[str, bool]:
    if state.db.one("SELECT id FROM projects WHERE id = ?", (project_id,)) is None:
        raise HTTPException(404, "Project not found")
    for row in state.db.all("SELECT id FROM features WHERE project_id = ?", (project_id,)):
        await state.orchestrator.cancel(row["id"])
    state.db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    return {"ok": True}


# ----------------------------------------------------------------------------- overview


@router.get("/overview")
def overview(state: State, project_id: int | None = None) -> Overview:
    ov = build_overview(
        state.db, project_id, state.settings.budget_usd_week, state.settings.models,
        list(state.runner.active.values()), state.runner.context_pct,
        billing=state.settings.billing, budget_tokens=state.settings.budget_tokens_week)
    ov.limits = limits.read(state.db)
    plan = PLANS.get(state.settings.plan or "")
    if state.settings.billing == "subscription" and plan:
        api_usd = ov.spend.total_usd
        ov.spend.plan = plan.name
        ov.spend.plan_cost_usd = round(plan.real_cost(api_usd), 2)
        ov.spend.plan_week_usd = round(plan.price_week, 2)
        ov.spend.plan_used_pct = round(plan.used_pct(api_usd), 1)
    return ov


# ----------------------------------------------------------------------------- features


@router.get("/features")
def list_features(
    state: State, project_id: int | None = None, status: str | None = None,
) -> list[FeatureSummary]:
    sql, params = "SELECT * FROM features WHERE 1 = 1", []
    if project_id is not None:
        sql += " AND project_id = ?"
        params.append(project_id)
    if status:
        wanted = [s.strip() for s in status.split(",") if s.strip()]
        sql += f" AND status IN ({','.join('?' * len(wanted))})"
        params.extend(wanted)
    rows = state.db.all(sql + " ORDER BY id DESC", params)
    return [summary_of(state.db, r) for r in rows]


@router.post("/features")
async def create_feature(body: FeatureCreate, state: State) -> FeatureSummary:
    if state.db.one("SELECT id FROM projects WHERE id = ?", (body.project_id,)) is None:
        raise HTTPException(404, "Project not found")
    fid = state.orchestrator.create_feature(body.project_id, body.title.strip(), body.spec)
    return summary_of(state.db, _feature(state, fid))


@router.get("/features/{feature_id}")
def get_feature(feature_id: int, state: State) -> FeatureDetail:
    return _detail(state, feature_id)


@router.get("/features/{feature_id}/events")
def feature_events(
    feature_id: int, state: State, agent: str | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200, before_id: int | None = None,
) -> list[Event]:
    _feature(state, feature_id)
    sql, params = "SELECT * FROM events WHERE feature_id = ?", [feature_id]
    if agent:
        sql += " AND agent = ?"
        params.append(agent)
    if before_id is not None:
        sql += " AND id < ?"
        params.append(before_id)
    rows = state.db.all(sql + " ORDER BY id DESC LIMIT ?", [*params, limit])
    return [row_to_event(r) for r in rows]


@router.post("/features/{feature_id}/answers")
async def answer(feature_id: int, body: AnswersBody, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    state.orchestrator.answer(feature_id, {a.id: a.answer for a in body.answers})
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/approve")
async def approve(feature_id: int, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    state.orchestrator.approve(feature_id)
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/request-changes")
async def request_changes(feature_id: int, body: NoteBody, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    state.orchestrator.request_changes(feature_id, body.note)
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/pause")
async def pause(feature_id: int, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    state.orchestrator.pause(feature_id)
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/resume")
async def resume(feature_id: int, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    state.orchestrator.resume(feature_id)
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/stop")
async def stop(feature_id: int, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    state.orchestrator.stop(feature_id)
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/merge")
async def merge(feature_id: int, body: MergeBody, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    await state.orchestrator.merge(feature_id, body)
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/send-back")
async def send_back(feature_id: int, body: NoteBody, state: State) -> FeatureDetail:
    _feature(state, feature_id)
    state.orchestrator.send_back(feature_id, body.note)
    return _detail(state, feature_id)


@router.post("/features/{feature_id}/message")
async def message(feature_id: int, body: MessageBody, state: State) -> dict[str, bool]:
    _feature(state, feature_id)
    state.orchestrator.message(feature_id, body.agent, body.text)
    return {"ok": True}


# ----------------------------------------------------------------------------- settings


@router.get("/settings")
def get_settings(state: State) -> Settings:
    return state.settings.view()


@router.get("/models")
def get_models(refresh: bool = False) -> ModelCatalog:
    """Claude models for the Settings dropdowns: live from the Anthropic API, else built in."""
    return catalog(refresh)


@router.put("/settings")
def put_settings(body: SettingsUpdate, state: State) -> Settings:
    state.settings.update(body)
    return state.settings.view()
