from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from canvas_api.config import Settings
from langgraph.checkpoint.base import BaseCheckpointSaver
from sqlalchemy.engine import make_url


@asynccontextmanager
async def open_checkpointer(settings: Settings) -> AsyncIterator[BaseCheckpointSaver]:
    database_url = make_url(settings.database_url)
    if database_url.drivername.startswith("sqlite"):
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(database_url.database or ":memory:") as saver:
            await saver.setup()
            yield saver
        return

    if database_url.drivername.startswith("postgresql"):
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

        connection_string = database_url.set(drivername="postgresql").render_as_string(
            hide_password=False
        )
        async with AsyncPostgresSaver.from_conn_string(connection_string) as saver:
            await saver.setup()
            yield saver
        return

    raise ValueError("Agent 工作流仅支持 SQLite 或 PostgreSQL 检查点存储")
