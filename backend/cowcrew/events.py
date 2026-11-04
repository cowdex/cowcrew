"""Event bus: persist every Event and broadcast it (plus feature summaries) to /ws subscribers."""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections.abc import Callable
from typing import Any

from cowcrew.db import Database, dumps, loads, now_iso
from cowcrew.models import Event, FeatureSummary

MAX_QUEUE = 1000


def row_to_event(row: Any) -> Event:
    return Event(
        id=row["id"],
        feature_id=row["feature_id"],
        task_id=row["task_id"],
        ts=row["ts"],
        agent=row["agent"],
        kind=row["kind"],
        message=row["message"],
        data=loads(row["data"], {}),
    )


class EventBus:
    """Fan-out of JSON messages to WebSocket subscribers; safe to call from any thread."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self.summary_of: Callable[[int], FeatureSummary | None] | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_QUEUE)
        with self._lock:
            self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscribers.discard(queue)

    def emit(
        self,
        feature_id: int | None,
        agent: str,
        kind: str,
        message: str,
        data: dict[str, Any] | None = None,
        task_id: int | None = None,
        ts: str | None = None,
    ) -> Event:
        """Persist an event and broadcast it."""
        payload = data or {}
        stamp = ts or now_iso()
        event_id = self.db.insert(
            "events",
            feature_id=feature_id,
            task_id=task_id,
            ts=stamp,
            agent=agent,
            kind=kind,
            message=message,
            data=dumps(payload),
        )
        event = Event(
            id=event_id, feature_id=feature_id, task_id=task_id, ts=stamp,
            agent=agent, kind=kind, message=message, data=payload,  # type: ignore[arg-type]
        )
        self._broadcast({"type": "event", "event": event.model_dump()})
        return event

    def feature_changed(self, feature_id: int) -> None:
        """Broadcast the feature's current summary."""
        if self.summary_of is None:
            return
        summary = self.summary_of(feature_id)
        if summary is not None:
            self._broadcast({"type": "feature", "feature": summary.model_dump()})

    def _broadcast(self, message: dict[str, Any]) -> None:
        with self._lock:
            queues = list(self._subscribers)
        if not queues:
            return
        loop = self._loop
        for queue in queues:
            if loop is not None and loop.is_running() and not _in_loop(loop):
                loop.call_soon_threadsafe(_offer, queue, message)
            else:
                _offer(queue, message)


def _in_loop(loop: asyncio.AbstractEventLoop) -> bool:
    try:
        return asyncio.get_running_loop() is loop
    except RuntimeError:
        return False


def _offer(queue: asyncio.Queue[dict[str, Any]], message: dict[str, Any]) -> None:
    """Enqueue without blocking; a slow client drops its oldest message instead."""
    if queue.full():
        with contextlib.suppress(asyncio.QueueEmpty):
            queue.get_nowait()
    queue.put_nowait(message)
