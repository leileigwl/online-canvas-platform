from __future__ import annotations

from contextlib import asynccontextmanager

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from canvas_api.config import Settings, get_settings
from canvas_api.database import create_database
from canvas_api.models import Base
from canvas_api.providers.images import UnconfiguredImageProvider
from canvas_api.routes import router
from canvas_api.storage import create_storage


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()
    engine, session_factory = create_database(config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = config
        app.state.engine = engine
        app.state.session_factory = session_factory
        app.state.object_storage = create_storage(config)
        app.state.image_provider = UnconfiguredImageProvider()
        app.state.redis = None
        if config.auto_create_schema:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
        if config.queue_enabled:
            try:
                app.state.redis = await create_pool(RedisSettings.from_dsn(config.redis_url))
            except Exception:
                app.state.redis = None
        yield
        if app.state.redis is not None:
            app.state.redis.close()
            await app.state.redis.wait_closed()
        await engine.dispose()

    app = FastAPI(
        title="FlowCanvas API",
        description="个人在线画布、素材、Agent 运行与 Provider 接口。",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Last-Event-ID"],
    )
    app.include_router(router)

    @app.get("/api/health", tags=["health"])
    async def health() -> dict:
        dependencies = {"database": "ok", "queue": "ok" if app.state.redis else "unavailable"}
        try:
            async with session_factory() as session:
                await session.execute(text("SELECT 1"))
        except Exception as error:
            dependencies["database"] = "unavailable"
            raise HTTPException(
                503, detail={"status": "unavailable", "dependencies": dependencies}
            ) from error
        return {"status": "ok", "dependencies": dependencies}

    return app


app = create_app()
