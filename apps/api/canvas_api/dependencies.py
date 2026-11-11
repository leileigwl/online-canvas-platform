from __future__ import annotations

from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from canvas_api.database import get_db_session
from canvas_api.models import User, UserSession
from canvas_api.security import token_digest


async def optional_user(
    request: Request,
    session: AsyncSession = Depends(get_db_session),
) -> User | None:
    token = request.cookies.get("flowcanvas_session")
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


async def current_user(
    user: User | None = Depends(optional_user),
) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "请先登录")
    return user


def not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, "资源不存在")
