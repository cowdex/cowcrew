"""SQLite persistence: schema, a thread-safe connection wrapper and the settings table."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    github_repo TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    spec TEXT NOT NULL,
    status TEXT NOT NULL,
    resume_status TEXT,
    return_status TEXT,
    managed INTEGER NOT NULL DEFAULT 1,
    branch TEXT,
    worktree_path TEXT,
    workspace_ready INTEGER NOT NULL DEFAULT 0,
    pr_number INTEGER,
    pr_url TEXT,
    current_task_id INTEGER,
    adr TEXT,
    glossary_terms TEXT NOT NULL DEFAULT '[]',
    estimate TEXT,
    change_note TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    diff_stats TEXT,
    protected_touched INTEGER NOT NULL DEFAULT 0,
    merged_commit TEXT,
    verified_sha TEXT,
    accept_rounds INTEGER NOT NULL DEFAULT 0,
    review_round INTEGER NOT NULL DEFAULT 0,
    ci_rounds INTEGER NOT NULL DEFAULT 0,
    ci_enabled INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    ready_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    depends_on TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    commit_sha TEXT,
    kind TEXT NOT NULL DEFAULT 'plan',
    last_report TEXT,
    committed_at TEXT
);
CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    severity TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    text TEXT NOT NULL,
    status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acceptances (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL,
    summary TEXT NOT NULL,
    criteria TEXT NOT NULL,
    issues TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ci_runs (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    jobs TEXT NOT NULL DEFAULT '[]',
    failing_job TEXT,
    failing_log TEXT,
    diagnosis TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER REFERENCES features(id) ON DELETE CASCADE,
    task_id INTEGER,
    ts TEXT NOT NULL,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_feature ON events(feature_id, id);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def now_iso() -> str:
    """Current UTC time as an ISO-8601 string with a Z suffix (sortable as text)."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def loads(value: str | None, default: Any = None) -> Any:
    return json.loads(value) if value else default


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


class Database:
    """One shared SQLite connection guarded by a lock (the app is a single local process)."""

    def __init__(self, path: Path | str) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Add columns introduced after a database was first created."""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(features)")}
        if "verified_sha" not in cols:
            self._conn.execute("ALTER TABLE features ADD COLUMN verified_sha TEXT")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Run a write statement; returns lastrowid."""
        with self._lock:
            return self._conn.execute(sql, params).lastrowid or 0

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def scalar(self, sql: str, params: Sequence[Any] = ()) -> Any:
        row = self.one(sql, params)
        return row[0] if row else None

    def update(self, table: str, row_id: int, **fields: Any) -> None:
        """UPDATE one row by id. Column names come from code, never from user input."""
        if not fields:
            return
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.execute(f"UPDATE {table} SET {cols} WHERE id = ?", (*fields.values(), row_id))  # noqa: S608

    def insert(self, table: str, **fields: Any) -> int:
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        return self.execute(
            f"INSERT INTO {table} ({cols}) VALUES ({marks})",  # noqa: S608
            tuple(fields.values()),
        )

    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.one("SELECT value FROM settings WHERE key = ?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )

    def wipe(self) -> None:
        with self._lock:
            for table in (
                "events", "messages", "ci_runs", "acceptances", "findings", "tasks",
                "questions", "features", "projects", "settings",
            ):
                self._conn.execute(f"DELETE FROM {table}")  # noqa: S608
