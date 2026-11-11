from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from canvas_api.config import Settings, get_settings


def create_database(settings: Settings | None = None):
    config = settings or get_settings()
    connect_args = {"check_same_thread": False} if config.database_url.startswith("sqlite") else {}
    engine = create_async_engine(config.database_url, pool_pre_ping=True, connect_args=connect_args)
    if config.database_url.startswith("sqlite"):

        @event.listens_for(engine.sync_engine, "connect")
        def enable_sqlite_foreign_keys(connection, _record) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine, async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.session_factory() as session:
        yield session
