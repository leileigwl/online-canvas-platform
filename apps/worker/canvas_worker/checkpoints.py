from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from canvas_api.config import Settings
from langgraph.checkpoint.base import BaseCheckpointSaver
from sqlalchemy.engine import make_url

_SETUP_READY: set[str] = set()
_SETUP_LOCK = asyncio.Lock()


async def _ensure_setup_once(key: str, saver: BaseCheckpointSaver) -> None:
    if key in _SETUP_READY:
        return
    async with _SETUP_LOCK:
        if key in _SETUP_READY:
            return
        await saver.setup()  # type: ignore[attr-defined]
        _SETUP_READY.add(key)


async def ensure_checkpointer_ready(settings: Settings) -> None:
    async with open_checkpointer(settings):
        return None


@asynccontextmanager
async def open_checkpointer(settings: Settings) -> AsyncIterator[BaseCheckpointSaver]:
    database_url = make_url(settings.database_url)
    setup_key = f"{database_url.drivername}:{database_url.host}:{database_url.database}"
    if database_url.drivername.startswith("sqlite"):
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(database_url.database or ":memory:") as saver:
            await _ensure_setup_once(setup_key, saver)
            yield saver
        return

    if database_url.drivername.startswith("postgresql"):
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

        connection_string = database_url.set(drivername="postgresql").render_as_string(
            hide_password=False
        )
        async with AsyncPostgresSaver.from_conn_string(connection_string) as saver:
            await _ensure_setup_once(setup_key, saver)
            yield saver
        return

    raise ValueError("Agent 工作流仅支持 SQLite 或 PostgreSQL 检查点存储")
