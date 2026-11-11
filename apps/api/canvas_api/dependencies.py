from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from canvas_api.database import get_db_session
from canvas_api.models import User, UserSession
from canvas_api.security import token_digest


async def resolve_user_from_token(session: AsyncSession, token: str | None) -> User | None:
    if not token:
        return None
    row = await session.scalar(
        select(UserSession).where(UserSession.token_hash == token_digest(token))
    )
    expires_at = (
        row.expires_at.replace(tzinfo=UTC)
        if row and row.expires_at.tzinfo is None
        else (row.expires_at if row else None)
    )
    if row is None or expires_at <= datetime.now(UTC):
        if row is not None:
            await session.delete(row)
            await session.commit()
        return None
    return await session.get(User, row.user_id)


async def optional_user(
    request: Request,
    session: AsyncSession = Depends(get_db_session),
) -> User | None:
    return await resolve_user_from_token(session, request.cookies.get("flowcanvas_session"))


async def current_user(
    user: User | None = Depends(optional_user),
) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "请先登录")
    return user


async def get_redis_pool(app) -> ArqRedis | None:
    settings = app.state.settings
    if not settings.queue_enabled:
        return None
    if app.state.redis is not None:
        return app.state.redis
    lock: asyncio.Lock | None = getattr(app.state, "redis_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        app.state.redis_lock = lock
    async with lock:
        if app.state.redis is not None:
            return app.state.redis
        try:
            app.state.redis = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        except Exception:
            app.state.redis = None
        return app.state.redis


def not_found(detail: str = "资源不存在") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail)
