from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from arq.jobs import Job
from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from canvas_api.config import Settings
from canvas_api.database import get_db_session
from canvas_api.dependencies import (
    current_user,
    get_redis_pool,
    not_found,
    optional_user,
    resolve_user_from_token,
)
from canvas_api.email_service import (
    EmailDeliveryError,
    hash_email_code,
    send_verification_email,
    verify_email_code_digest,
)
from canvas_api.image_assets import persist_generated_images, resolve_user_image_provider
from canvas_api.models import (
    AgentRun,
    AgentTask,
    Asset,
    AuditEvent,
    Canvas,
    CanvasMemory,
    CanvasVersion,
    EmailVerificationCode,
    ImageModelConfig,
    ModelConfig,
    Project,
    RunEvent,
    RunStatus,
    User,
    UserSession,
)
from canvas_api.providers.chat import (
    OpenAICompatibleChatProvider,
    ProviderError,
    validate_public_https_url,
)
from canvas_api.providers.images import (
    ConfiguredImageProvider,
    ImageGenerationRequest,
    ImageProviderError,
    ImageProviderNotConfigured,
    MockImageProvider,
    ReferenceImage,
)
from canvas_api.schemas import (
    AgentRunCreate,
    AgentRunOut,
    AgentTaskOut,
    ApplyProposal,
    AssetOut,
    BindEmailRequest,
    CanvasCreate,
    CanvasDocument,
    CanvasMemoryOut,
    CanvasOut,
    CanvasRestore,
    CanvasSave,
    CanvasUpdate,
    CanvasVersionOut,
    EmailCodeRequest,
    FavoriteUpdate,
    GenerationRequest,
    HarnessInspectRequest,
    ImageModelConfigInput,
    ImageModelConfigOut,
    LoginRequest,
    MemoryCompactRequest,
    ModelConfigInput,
    ModelConfigOut,
    PasswordChange,
    PasswordResetRequest,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
    UserCreate,
    UserOut,
)
from canvas_api.security import (
    decrypt_secret,
    encrypt_secret,
    enforce_rate_limit,
    hash_password_async,
    new_session_token,
    token_digest,
    verify_password_async,
)
from canvas_api.storage import ObjectStorage
from canvas_api.tools import (
    PlanValidationError,
    apply_canvas_operation,
    public_tool_specs,
    validate_plan,
    verify_proposal_layout,
)

router = APIRouter(prefix="/api")
SESSION_COOKIE = "flowcanvas_session"
ALLOWED_IMAGE_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
MAX_CANVAS_VERSIONS = 12
logger = logging.getLogger(__name__)


def _iso(value: datetime) -> str:
    return value.isoformat()


def _user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        email_verified=bool(user.email and user.email_verified),
    )


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


async def _verify_and_consume_email_code(
    session: AsyncSession,
    *,
    email: str,
    purpose: str,
    code: str,
    settings: Settings,
) -> EmailVerificationCode:
    row = await session.scalar(
        select(EmailVerificationCode)
        .where(
            func.lower(EmailVerificationCode.email) == email.lower(),
            EmailVerificationCode.purpose == purpose,
            EmailVerificationCode.consumed_at.is_(None),
        )
        .order_by(EmailVerificationCode.created_at.desc())
        .limit(1)
        .with_for_update()
    )
    now = datetime.now(UTC)
    if row is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "邮箱验证码无效或尚未发送")
    if _as_utc(row.expires_at) <= now:
        row.consumed_at = now
        await session.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "邮箱验证码已过期，请重新获取")
    if row.attempts >= settings.email_code_max_attempts:
        row.consumed_at = now
        await session.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "验证码错误次数过多，请重新获取")
    if not verify_email_code_digest(purpose, email, code, row.code_hash, settings):
        row.attempts += 1
        if row.attempts >= settings.email_code_max_attempts:
            row.consumed_at = now
        await session.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "邮箱验证码不正确")
    row.consumed_at = now
    return row


async def _audit_event(
    session: AsyncSession,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: str | None = None,
    details: dict | None = None,
) -> None:
    session.add(
        AuditEvent(
            actor_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or {},
        )
    )


async def _enforce_active_run_limit(
    session: AsyncSession, user_id: uuid.UUID, maximum: int
) -> None:
    # Serialize run creation per account in PostgreSQL before counting active runs.
    await session.scalar(select(User.id).where(User.id == user_id).with_for_update())
    active_count = await session.scalar(
        select(func.count(AgentRun.id)).where(
            AgentRun.owner_id == user_id,
            AgentRun.status.in_((RunStatus.QUEUED, RunStatus.RUNNING)),
        )
    )
    if (active_count or 0) >= maximum:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"当前最多同时运行 {maximum} 个 Agent 任务，请等待已有任务完成。",
        )


def _canvas_out(canvas: Canvas) -> CanvasOut:
    return CanvasOut(
        id=canvas.id,
        project_id=canvas.project_id,
        name=canvas.name,
        document=canvas.document,
        viewport=canvas.viewport,
        schema_version=canvas.schema_version,
        revision=canvas.revision,
        updated_at=_iso(canvas.updated_at),
    )


def _asset_out(asset: Asset) -> AssetOut:
    return AssetOut(
        id=asset.id,
        name=asset.name,
        mime_type=asset.mime_type,
        size_bytes=asset.size_bytes,
        width=asset.width,
        height=asset.height,
        favorite=asset.favorite,
        temporary=asset.temporary,
        src=f"/api/assets/{asset.id}/content",
        created_at=_iso(asset.created_at),
    )


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if forwarded:
        return forwarded[:64]
    return request.client.host if request.client else "unknown"


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _inspect_image(content: bytes) -> tuple[str, int, int]:
    try:
        with Image.open(io.BytesIO(content)) as image:
            mime_type = ALLOWED_IMAGE_FORMATS.get(image.format or "")
            width, height = image.size
            if mime_type is None:
                raise HTTPException(
                    status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "仅支持 JPG、PNG 或 WebP 图片"
                )
            if width <= 0 or height <= 0 or width > 20_000 or height > 20_000:
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "图片尺寸超过限制")
            if width * height > 100_000_000:
                raise HTTPException(
                    status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "图片像素总量超过限制"
                )
            image.load()
    except HTTPException:
        raise
    except Image.DecompressionBombError:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "图片像素总量超过限制"
        ) from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "仅支持有效的 JPG、PNG 或 WebP 图片"
        ) from None
    return mime_type, width, height


def _revision_conflict(canvas: Canvas) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "revision_conflict",
            "message": "画布已在其他会话更新，请先载入最新版本或保留本地草稿。",
            "current_revision": canvas.revision,
            "current_document": canvas.document,
            "current_viewport": canvas.viewport,
        },
    )


async def _owned_canvas(session: AsyncSession, user_id: uuid.UUID, canvas_id: uuid.UUID) -> Canvas:
    result = await session.execute(
        select(Canvas)
        .join(Project, Canvas.project_id == Project.id)
        .where(Canvas.id == canvas_id, Project.owner_id == user_id)
    )
    canvas = result.scalar_one_or_none()
    if canvas is None:
        raise not_found()
    return canvas


async def _owned_project(
    session: AsyncSession, user_id: uuid.UUID, project_id: uuid.UUID
) -> Project:
    project = await session.scalar(
        select(Project).where(Project.id == project_id, Project.owner_id == user_id)
    )
    if project is None:
        raise not_found()
    return project


def _cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_days * 24 * 60 * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


async def _create_session(
    session: AsyncSession,
    user: User,
    settings: Settings,
    response: Response,
    audit_action: str = "auth.login",
) -> None:
    token = new_session_token()
    session.add(
        UserSession(
            user_id=user.id,
            token_hash=token_digest(token),
            expires_at=datetime.now(UTC) + timedelta(days=settings.session_days),
        )
    )
    await _audit_event(session, user.id, audit_action, "user", str(user.id))
    await session.commit()
    _cookie(response, token, settings)


@router.post("/auth/email-code")
async def send_email_code(
    payload: EmailCodeRequest,
    request: Request,
    actor: User | None = Depends(optional_user),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    settings: Settings = request.app.state.settings
    email = payload.email.lower()
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_email_code_ip",
        _client_ip(request),
        limit=max(settings.auth_rate_limit_per_minute * 2, 20),
    )
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_email_code",
        f"{payload.purpose}:{email[:80]}",
        limit=settings.auth_rate_limit_per_minute,
    )

    if payload.purpose == "bind_email":
        if actor is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "请先登录后再绑定邮箱")
        if actor.email and actor.email.lower() == email and actor.email_verified:
            raise HTTPException(status.HTTP_409_CONFLICT, "当前账户已绑定该邮箱")

    existing_email_user = await session.scalar(select(User).where(func.lower(User.email) == email))
    if payload.purpose == "register" and existing_email_user is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "该邮箱已注册账户")
    if (
        payload.purpose == "bind_email"
        and existing_email_user is not None
        and actor is not None
        and existing_email_user.id != actor.id
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "该邮箱已被其他账户绑定")
    if payload.purpose == "reset_password" and (
        existing_email_user is None or not existing_email_user.email_verified
    ):
        return {
            "sent": True,
            "expires_in_seconds": settings.email_code_ttl_seconds,
            "cooldown_seconds": settings.email_code_cooldown_seconds,
            "message": "如果该邮箱已绑定账户，验证码已发送至您的邮箱",
        }

    now = datetime.now(UTC)
    latest_code = await session.scalar(
        select(EmailVerificationCode)
        .where(
            func.lower(EmailVerificationCode.email) == email,
            EmailVerificationCode.purpose == payload.purpose,
        )
        .order_by(EmailVerificationCode.created_at.desc())
        .limit(1)
    )
    if latest_code is not None:
        elapsed = (now - _as_utc(latest_code.created_at)).total_seconds()
        if elapsed < settings.email_code_cooldown_seconds:
            retry_after = max(1, int(settings.email_code_cooldown_seconds - elapsed))
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                f"发送过于频繁，请在 {retry_after} 秒后重试",
            )

    code = f"{secrets.randbelow(1_000_000):06d}"
    code_row = EmailVerificationCode(
        email=email,
        purpose=payload.purpose,
        code_hash=hash_email_code(payload.purpose, email, code, settings),
        attempts=0,
        expires_at=now + timedelta(seconds=settings.email_code_ttl_seconds),
    )
    session.add(code_row)
    await session.flush()
    code_row_id = code_row.id
    await session.commit()

    try:
        await send_verification_email(settings, to_email=email, code=code, purpose=payload.purpose)
    except EmailDeliveryError as error:
        await session.execute(
            delete(EmailVerificationCode).where(EmailVerificationCode.id == code_row_id)
        )
        await session.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(error)) from error

    await session.execute(
        update(EmailVerificationCode)
        .where(
            func.lower(EmailVerificationCode.email) == email,
            EmailVerificationCode.purpose == payload.purpose,
            EmailVerificationCode.id != code_row_id,
            EmailVerificationCode.consumed_at.is_(None),
        )
        .values(consumed_at=now)
    )
    await _audit_event(
        session,
        actor.id if actor else None,
        "auth.email_code_sent",
        "email_verification",
        str(code_row_id),
        details={"purpose": payload.purpose, "domain": email.partition("@")[2]},
    )
    await session.commit()
    return {
        "sent": True,
        "expires_in_seconds": settings.email_code_ttl_seconds,
        "cooldown_seconds": settings.email_code_cooldown_seconds,
        "message": "验证码已发送，请查收邮箱",
    }


@router.post("/auth/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(
    payload: UserCreate,
    response: Response,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
) -> UserOut:
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_register",
        _client_ip(request),
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    username = payload.username.lower()
    email = payload.email.lower()
    existing = await session.scalar(select(User.id).where(func.lower(User.username) == username))
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "用户名已被使用")
    existing_email = await session.scalar(select(User.id).where(func.lower(User.email) == email))
    if existing_email:
        raise HTTPException(status.HTTP_409_CONFLICT, "该邮箱已注册账户")
    await _verify_and_consume_email_code(
        session,
        email=email,
        purpose="register",
        code=payload.verification_code,
        settings=request.app.state.settings,
    )
    password_hash = await hash_password_async(payload.password)
    user = User(
        username=username,
        email=email,
        email_verified=True,
        password_hash=password_hash,
    )
    try:
        session.add(user)
        await session.flush()
        project = Project(owner_id=user.id, name="我的画布")
        session.add(project)
        await session.flush()
        starter_doc = {
            "schema_version": 1,
            "items": [
                {
                    "id": "starter-welcome-note",
                    "type": "note",
                    "x": -180,
                    "y": -90,
                    "width": 360,
                    "height": 180,
                    "title": "FLOWCANVAS · 创意起点",
                    "content": (
                        "• 快捷键：V 选择/框选 · H/Space 抓手平移 · T 文字 · B 画笔 · Del 删除\n"
                        "• 右上或首页进入「设置」配置你自己的 LLM 与生图 API Key 即可开箱创作\n"
                        "• 点击画布上传图片并点选引用，下方「直接生图」或切换 AI Agent 协同创作"
                    ),
                    "visible": True,
                }
            ],
        }
        session.add(
            Canvas(
                project_id=project.id,
                name="我的第一个灵感画布",
                document=starter_doc,
                viewport={"x": 0, "y": 0, "scale": 1},
                schema_version=1,
                revision=0,
            )
        )
        token = new_session_token()
        session.add(
            UserSession(
                user_id=user.id,
                token_hash=token_digest(token),
                expires_at=datetime.now(UTC)
                + timedelta(days=request.app.state.settings.session_days),
            )
        )
        await _audit_event(session, user.id, "auth.register", "user", str(user.id))
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "用户名或邮箱已被使用") from error
    _cookie(response, token, request.app.state.settings)
    return _user_out(user)


@router.post("/auth/login", response_model=UserOut)
async def login(
    payload: LoginRequest,
    response: Response,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
) -> UserOut:
    identifier = payload.resolved_identifier.lower()
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_login",
        f"{_client_ip(request)}:{identifier[:64]}",
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    user = await session.scalar(
        select(User).where(
            or_(
                func.lower(User.username) == identifier,
                (func.lower(User.email) == identifier) & User.email_verified.is_(True),
            )
        )
    )
    if user is None or not await verify_password_async(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名、邮箱或密码错误")
    await _create_session(session, user, request.app.state.settings, response)
    return _user_out(user)


@router.get("/auth/session")
async def session_status(user: User | None = Depends(optional_user)) -> dict:
    return {"authenticated": user is not None, "user": _user_out(user) if user else None}


@router.get("/auth/me", response_model=UserOut)
async def me(user: User = Depends(current_user)) -> UserOut:
    return _user_out(user)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        row = await session.scalar(
            select(UserSession).where(UserSession.token_hash == token_digest(token))
        )
        if row is not None:
            await _audit_event(session, row.user_id, "auth.logout", "user", str(row.user_id))
            await session.delete(row)
            await session.commit()
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="lax",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.patch("/auth/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    payload: PasswordChange,
    request: Request,
    response: Response,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_password",
        str(user.id),
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    if not await verify_password_async(payload.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "当前密码不正确")
    user.password_hash = await hash_password_async(payload.new_password)
    await session.execute(UserSession.__table__.delete().where(UserSession.user_id == user.id))
    await _create_session(
        session,
        user,
        request.app.state.settings,
        response,
        audit_action="auth.password_changed",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/auth/password/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(
    payload: PasswordResetRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    email = payload.email.lower()
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_password_reset",
        f"{_client_ip(request)}:{email[:64]}",
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    await _verify_and_consume_email_code(
        session,
        email=email,
        purpose="reset_password",
        code=payload.verification_code,
        settings=request.app.state.settings,
    )
    user = await session.scalar(
        select(User).where(func.lower(User.email) == email, User.email_verified.is_(True))
    )
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "该邮箱尚未绑定可用账户")
    user.password_hash = await hash_password_async(payload.new_password)
    await session.execute(delete(UserSession).where(UserSession.user_id == user.id))
    await _audit_event(session, user.id, "auth.password_reset", "user", str(user.id))
    await session.commit()
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="lax",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/auth/email/bind", response_model=UserOut)
async def bind_email(
    payload: BindEmailRequest,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> UserOut:
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_email_bind",
        str(user.id),
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    email = payload.email.lower()
    existing = await session.scalar(
        select(User.id).where(func.lower(User.email) == email, User.id != user.id)
    )
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "该邮箱已被其他账户绑定")
    await _verify_and_consume_email_code(
        session,
        email=email,
        purpose="bind_email",
        code=payload.verification_code,
        settings=request.app.state.settings,
    )
    user.email = email
    user.email_verified = True
    await _audit_event(
        session,
        user.id,
        "auth.email_bound",
        "user",
        str(user.id),
        details={"domain": email.partition("@")[2]},
    )
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "该邮箱已被其他账户绑定") from error
    return _user_out(user)


@router.delete("/auth/account", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    payload: LoginRequest,
    request: Request,
    response: Response,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await enforce_rate_limit(
        request.app.state.redis,
        "auth_delete",
        str(user.id),
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    confirm_ident = payload.resolved_identifier.lower()
    matches_identity = confirm_ident == user.username.lower() or (
        bool(user.email) and bool(user.email_verified) and confirm_ident == user.email.lower()
    )
    if not matches_identity or not await verify_password_async(
        payload.password, user.password_hash
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "账户确认信息不正确")
    assets = list(await session.scalars(select(Asset).where(Asset.owner_id == user.id)))
    object_keys = [asset.object_key for asset in assets]
    deleted_uid = str(user.id)
    await _audit_event(session, None, "auth.account_deleted", "user", deleted_uid)
    await session.delete(user)
    await session.commit()
    for object_key in object_keys:
        try:
            await request.app.state.object_storage.delete(object_key)
        except Exception as error:
            logger.warning(
                "Post-delete asset cleanup failed key=%s error_type=%s",
                object_key,
                type(error).__name__,
            )
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="lax",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[ProjectOut]:
    projects = await session.scalars(
        select(Project).where(Project.owner_id == user.id).order_by(Project.updated_at.desc())
    )
    return [
        ProjectOut(id=item.id, name=item.name, updated_at=_iso(item.updated_at))
        for item in projects
    ]


@router.post("/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ProjectOut:
    project = Project(owner_id=user.id, name=payload.name.strip())
    session.add(project)
    await session.flush()
    await _audit_event(session, user.id, "project.created", "project", str(project.id))
    await session.commit()
    await session.refresh(project)
    return ProjectOut(id=project.id, name=project.name, updated_at=_iso(project.updated_at))


@router.patch("/projects/{project_id}", response_model=ProjectOut)
async def rename_project(
    project_id: uuid.UUID,
    payload: ProjectUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ProjectOut:
    project = await _owned_project(session, user.id, project_id)
    project.name = payload.name.strip()
    await _audit_event(session, user.id, "project.renamed", "project", str(project.id))
    await session.commit()
    await session.refresh(project)
    return ProjectOut(id=project.id, name=project.name, updated_at=_iso(project.updated_at))


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    project = await _owned_project(session, user.id, project_id)
    await _audit_event(session, user.id, "project.deleted", "project", str(project.id))
    await session.delete(project)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/projects/{project_id}/canvases", response_model=list[CanvasOut])
async def list_canvases(
    project_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[CanvasOut]:
    await _owned_project(session, user.id, project_id)
    canvases = await session.scalars(
        select(Canvas).where(Canvas.project_id == project_id).order_by(Canvas.updated_at.desc())
    )
    return [_canvas_out(canvas) for canvas in canvases]


@router.post("/canvases", response_model=CanvasOut, status_code=status.HTTP_201_CREATED)
async def create_canvas(
    payload: CanvasCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasOut:
    if payload.project_id:
        project = await _owned_project(session, user.id, payload.project_id)
    else:
        project = await session.scalar(select(Project).where(Project.owner_id == user.id).limit(1))
        if project is None:
            project = Project(owner_id=user.id, name="我的画布")
            session.add(project)
            await session.flush()
    canvas = Canvas(
        project_id=project.id,
        name=payload.name.strip(),
        document={"schema_version": 1, "items": []},
        viewport={"x": 0, "y": 0, "scale": 1},
        schema_version=1,
        revision=0,
    )
    session.add(canvas)
    await session.flush()
    await _audit_event(session, user.id, "canvas.created", "canvas", str(canvas.id))
    await session.commit()
    await session.refresh(canvas)
    return _canvas_out(canvas)


@router.get("/canvases/{canvas_id}", response_model=CanvasOut)
async def get_canvas(
    canvas_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasOut:
    return _canvas_out(await _owned_canvas(session, user.id, canvas_id))


@router.patch("/canvases/{canvas_id}", response_model=CanvasOut)
async def rename_canvas(
    canvas_id: uuid.UUID,
    payload: CanvasUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasOut:
    canvas = await _owned_canvas(session, user.id, canvas_id)
    canvas.name = payload.name.strip()
    await _audit_event(session, user.id, "canvas.renamed", "canvas", str(canvas.id))
    await session.commit()
    await session.refresh(canvas)
    return _canvas_out(canvas)


@router.delete("/canvases/{canvas_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_canvas(
    canvas_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    canvas = await _owned_canvas(session, user.id, canvas_id)
    await _audit_event(session, user.id, "canvas.deleted", "canvas", str(canvas.id))
    await session.delete(canvas)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/canvases/{canvas_id}", response_model=CanvasOut)
async def save_canvas(
    canvas_id: uuid.UUID,
    payload: CanvasSave,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasOut:
    canvas = await _owned_canvas(session, user.id, canvas_id)
    document = payload.document.model_dump(mode="json")
    asset_ids = {item.asset_id for item in payload.document.items if item.asset_id}
    if asset_ids:
        owned_ids = set(
            await session.scalars(
                select(Asset.id).where(Asset.owner_id == user.id, Asset.id.in_(asset_ids))
            )
        )
        if asset_ids != owned_ids:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "画布引用了未拥有的图片素材")
    if payload.base_revision != canvas.revision:
        raise _revision_conflict(canvas)
    previous_revision = canvas.revision
    previous_document = canvas.document
    previous_viewport = canvas.viewport
    result = await session.execute(
        update(Canvas)
        .where(Canvas.id == canvas.id, Canvas.revision == payload.base_revision)
        .values(
            document=document,
            viewport=payload.viewport.model_dump(mode="json"),
            schema_version=payload.document.schema_version,
            revision=Canvas.revision + 1,
            updated_at=func.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.rollback()
        raise _revision_conflict(await _owned_canvas(session, user.id, canvas_id))
    await _record_canvas_version(
        session, canvas.id, previous_revision, previous_document, previous_viewport, force=False
    )
    await _audit_event(
        session,
        user.id,
        "canvas.saved",
        "canvas",
        str(canvas.id),
        {"from_revision": previous_revision, "to_revision": previous_revision + 1},
    )
    await session.commit()
    await session.refresh(canvas)
    return _canvas_out(canvas)


async def _record_canvas_version(
    session: AsyncSession,
    canvas_id: uuid.UUID,
    revision: int,
    document: dict,
    viewport: dict,
    *,
    force: bool = False,
) -> None:
    """Persist bounded canvas checkpoints without spamming duplicate snapshots."""
    if not force:
        latest = await session.scalar(
            select(CanvasVersion)
            .where(CanvasVersion.canvas_id == canvas_id)
            .order_by(CanvasVersion.revision.desc())
            .limit(1)
        )
        if latest is not None and latest.document == document:
            return
    session.add(
        CanvasVersion(
            canvas_id=canvas_id,
            revision=revision,
            document=document,
            viewport=viewport,
        )
    )
    await session.flush()
    stale_ids = list(
        await session.scalars(
            select(CanvasVersion.id)
            .where(CanvasVersion.canvas_id == canvas_id)
            .order_by(CanvasVersion.revision.desc())
            .offset(MAX_CANVAS_VERSIONS)
        )
    )
    if stale_ids:
        await session.execute(delete(CanvasVersion).where(CanvasVersion.id.in_(stale_ids)))


@router.get("/canvases/{canvas_id}/versions", response_model=list[CanvasVersionOut])
async def list_canvas_versions(
    canvas_id: uuid.UUID,
    limit: int = Query(default=12, ge=1, le=50),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[CanvasVersionOut]:
    canvas = await _owned_canvas(session, user.id, canvas_id)
    versions = list(
        await session.scalars(
            select(CanvasVersion)
            .where(CanvasVersion.canvas_id == canvas.id)
            .order_by(CanvasVersion.revision.desc())
            .limit(limit)
        )
    )
    result = [
        CanvasVersionOut(
            revision=version.revision,
            created_at=_iso(version.created_at),
            schema_version=int(version.document.get("schema_version", 1)),
            object_count=len(version.document.get("items", [])),
        )
        for version in versions
    ]
    result.insert(
        0,
        CanvasVersionOut(
            revision=canvas.revision,
            created_at=_iso(canvas.updated_at),
            schema_version=canvas.schema_version,
            object_count=len(canvas.document.get("items", [])),
            is_current=True,
        ),
    )
    return result[:limit]


@router.post("/canvases/{canvas_id}/versions", response_model=CanvasVersionOut)
async def create_canvas_checkpoint(
    canvas_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasVersionOut:
    canvas = await _owned_canvas(session, user.id, canvas_id)
    existing = await session.scalar(
        select(CanvasVersion).where(
            CanvasVersion.canvas_id == canvas.id, CanvasVersion.revision == canvas.revision
        )
    )
    if existing is None:
        await _record_canvas_version(
            session, canvas.id, canvas.revision, canvas.document, canvas.viewport, force=True
        )
        await _audit_event(
            session,
            user.id,
            "canvas.checkpoint",
            "canvas",
            str(canvas.id),
            {"revision": canvas.revision},
        )
        await session.commit()
        existing = await session.scalar(
            select(CanvasVersion).where(
                CanvasVersion.canvas_id == canvas.id, CanvasVersion.revision == canvas.revision
            )
        )
    return CanvasVersionOut(
        revision=canvas.revision,
        created_at=_iso(existing.created_at if existing else canvas.updated_at),
        schema_version=canvas.schema_version,
        object_count=len((canvas.document or {}).get("items", [])),
        is_current=True,
    )


@router.post("/canvases/{canvas_id}/restore", response_model=CanvasOut)
async def restore_canvas_version(
    canvas_id: uuid.UUID,
    payload: CanvasRestore,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasOut:
    canvas = await _owned_canvas(session, user.id, canvas_id)
    if payload.base_revision != canvas.revision:
        raise _revision_conflict(canvas)
    if payload.version_revision == canvas.revision:
        return _canvas_out(canvas)

    version = await session.scalar(
        select(CanvasVersion).where(
            CanvasVersion.canvas_id == canvas.id,
            CanvasVersion.revision == payload.version_revision,
        )
    )
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "找不到该画布版本")

    previous_revision = canvas.revision
    previous_document = canvas.document
    previous_viewport = canvas.viewport
    restored_document = version.document
    result = await session.execute(
        update(Canvas)
        .where(Canvas.id == canvas.id, Canvas.revision == payload.base_revision)
        .values(
            document=restored_document,
            viewport=version.viewport,
            schema_version=int(restored_document.get("schema_version", 1)),
            revision=Canvas.revision + 1,
            updated_at=func.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.rollback()
        raise _revision_conflict(await _owned_canvas(session, user.id, canvas_id))

    await _record_canvas_version(
        session, canvas.id, previous_revision, previous_document, previous_viewport, force=True
    )
    await _audit_event(
        session,
        user.id,
        "canvas.version_restored",
        "canvas",
        str(canvas.id),
        {"from_revision": payload.version_revision, "to_revision": previous_revision + 1},
    )
    await session.commit()
    await session.refresh(canvas)
    return _canvas_out(canvas)


@router.get("/assets", response_model=list[AssetOut])
async def list_assets(
    search: str = "",
    favorite: bool | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[AssetOut]:
    query = select(Asset).where(Asset.owner_id == user.id, Asset.temporary.is_(False))
    if search.strip():
        escaped = _escape_like(search.strip())
        query = query.where(Asset.name.ilike(f"%{escaped}%", escape="\\"))
    if favorite is not None:
        query = query.where(Asset.favorite.is_(favorite))
    rows = await session.scalars(query.order_by(Asset.created_at.desc()))
    return [_asset_out(item) for item in rows]


@router.post("/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AssetOut:
    content = await file.read(request.app.state.settings.max_upload_bytes + 1)
    if not content or len(content) > request.app.state.settings.max_upload_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "图片为空或超过上传大小限制")
    detected_mime, width, height = _inspect_image(content)
    suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[detected_mime]
    object_key = f"{user.id}/{uuid.uuid4()}{suffix}"
    storage: ObjectStorage = request.app.state.object_storage
    await storage.put(object_key, content, detected_mime)
    asset = Asset(
        owner_id=user.id,
        name=Path(file.filename or "图片").name[:255],
        object_key=object_key,
        mime_type=detected_mime,
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        width=width,
        height=height,
    )
    session.add(asset)
    await session.flush()
    await _audit_event(
        session,
        user.id,
        "asset.uploaded",
        "asset",
        str(asset.id),
        {"mime_type": detected_mime, "size_bytes": len(content)},
    )
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        await storage.delete(object_key)
        raise
    await session.refresh(asset)
    return _asset_out(asset)


@router.get("/assets/{asset_id}/content")
async def get_asset_content(
    asset_id: uuid.UUID,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    asset = await session.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.owner_id == user.id)
    )
    if asset is None:
        raise not_found()
    content = await request.app.state.object_storage.get(asset.object_key)
    return Response(
        content,
        media_type=asset.mime_type,
        headers={
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@router.patch("/assets/{asset_id}/favorite", response_model=AssetOut)
async def set_favorite(
    asset_id: uuid.UUID,
    payload: FavoriteUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AssetOut:
    asset = await session.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.owner_id == user.id)
    )
    if asset is None:
        raise not_found()
    asset.favorite = payload.favorite
    await _audit_event(
        session,
        user.id,
        "asset.favorite_changed",
        "asset",
        str(asset.id),
        {"favorite": payload.favorite},
    )
    await session.commit()
    await session.refresh(asset)
    return _asset_out(asset)


@router.post("/assets/{asset_id}/save", response_model=AssetOut)
async def save_temporary_asset(
    asset_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AssetOut:
    asset = await session.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.owner_id == user.id)
    )
    if asset is None:
        raise not_found()
    asset.temporary = False
    await _audit_event(session, user.id, "asset.saved", "asset", str(asset.id))
    await session.commit()
    await session.refresh(asset)
    return _asset_out(asset)


@router.get("/agent/model-config", response_model=ModelConfigOut)
async def get_model_config(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ModelConfigOut:
    config = await session.scalar(select(ModelConfig).where(ModelConfig.owner_id == user.id))
    if config is None:
        return ModelConfigOut(
            provider="openai-compatible",
            base_url="",
            model_name="",
            role_models={},
            max_context_tokens=32768,
            configured=False,
        )
    return ModelConfigOut(
        provider=config.provider,
        base_url=config.base_url,
        model_name=config.model_name,
        role_models=config.role_models or {},
        max_context_tokens=config.max_context_tokens or 32768,
        configured=True,
    )


@router.put("/agent/model-config", response_model=ModelConfigOut)
async def save_model_config(
    payload: ModelConfigInput,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ModelConfigOut:
    try:
        base_url = await asyncio.to_thread(validate_public_https_url, payload.base_url)
    except ValueError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error
    config = await session.scalar(select(ModelConfig).where(ModelConfig.owner_id == user.id))
    if config is None and not payload.api_key:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "首次保存模型配置时需要提供 API 密钥"
        )
    if config is None:
        config = ModelConfig(
            owner_id=user.id,
            provider=payload.provider,
            base_url=base_url,
            model_name=payload.model_name,
            encrypted_api_key=encrypt_secret(payload.api_key or "", request.app.state.settings),
            role_models=payload.role_models,
            max_context_tokens=payload.max_context_tokens,
        )
        session.add(config)
    else:
        config.provider = payload.provider
        config.base_url = base_url
        config.model_name = payload.model_name
        config.role_models = payload.role_models
        config.max_context_tokens = payload.max_context_tokens
        if payload.api_key:
            config.encrypted_api_key = encrypt_secret(payload.api_key, request.app.state.settings)
    await session.flush()
    await _audit_event(session, user.id, "model_config.saved", "model_config", str(config.id))
    await session.commit()
    return ModelConfigOut(
        provider=config.provider,
        base_url=config.base_url,
        model_name=config.model_name,
        role_models=config.role_models or {},
        max_context_tokens=config.max_context_tokens or 32768,
        configured=True,
    )


@router.post("/agent/model-config/test")
async def test_model_config(
    payload: ModelConfigInput,
    request: Request,
    user: User = Depends(current_user),
) -> dict:
    """验证协议可连通；不会保存配置，也不会回显 API 密钥。"""
    await enforce_rate_limit(
        request.app.state.redis,
        "provider_test",
        str(user.id),
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    if not payload.api_key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "测试连接需要提供 API 密钥")
    try:
        base_url = await asyncio.to_thread(validate_public_https_url, payload.base_url)
    except ValueError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error
    try:
        await OpenAICompatibleChatProvider().complete_json(
            base_url=base_url,
            api_key=payload.api_key,
            model=payload.model_name,
            system="Return a JSON object with one key: ok, set to true.",
            user="Test the connection.",
            max_output_tokens=128,
            token_limit_field=request.app.state.settings.chat_completion_token_limit_field,
        )
    except Exception:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "无法连接模型服务，请检查地址和网络"
        ) from None
    return {"ok": True, "message": "模型服务连接成功"}


def _image_config_out(config: ImageModelConfig) -> ImageModelConfigOut:
    return ImageModelConfigOut(
        id=config.id,
        label=config.label,
        provider=config.provider,
        base_url=config.base_url,
        model_name=config.model_name,
        default_options=config.default_options or {},
        is_default=config.is_default,
        configured=True,
    )


async def _save_image_config_row(
    *,
    session: AsyncSession,
    user_id: uuid.UUID,
    payload: ImageModelConfigInput,
    settings: Settings,
    target_id: uuid.UUID | None = None,
    upsert_default_when_untargeted: bool = False,
) -> ImageModelConfig:
    if payload.provider == "mock":
        base_url = "https://mock.flowcanvas.local/v1"
    else:
        try:
            base_url = await asyncio.to_thread(validate_public_https_url, payload.base_url)
        except ValueError as error:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error

    existing: ImageModelConfig | None = None
    lookup_id = target_id or payload.id
    if lookup_id is not None:
        existing = await session.scalar(
            select(ImageModelConfig).where(
                ImageModelConfig.owner_id == user_id, ImageModelConfig.id == lookup_id
            )
        )
        if existing is None:
            raise not_found("未找到指定的生图配置")
    elif upsert_default_when_untargeted:
        existing = await session.scalar(
            select(ImageModelConfig)
            .where(ImageModelConfig.owner_id == user_id)
            .order_by(ImageModelConfig.is_default.desc(), ImageModelConfig.updated_at.desc())
        )

    if existing is None and not payload.api_key and payload.provider != "mock":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "首次保存生图配置时需要提供 API 密钥"
        )

    sibling_count = await session.scalar(
        select(func.count(ImageModelConfig.id)).where(ImageModelConfig.owner_id == user_id)
    )
    make_default = payload.is_default or (sibling_count == 0 and existing is None)
    if make_default:
        await session.execute(
            update(ImageModelConfig)
            .where(ImageModelConfig.owner_id == user_id)
            .values(is_default=False)
        )

    clean_label = payload.label.strip() or f"{payload.provider} · {payload.model_name}"[:80]
    if existing is None:
        existing = ImageModelConfig(
            owner_id=user_id,
            label=clean_label,
            provider=payload.provider,
            base_url=base_url,
            model_name=payload.model_name,
            encrypted_api_key=encrypt_secret(payload.api_key or "", settings),
            default_options=payload.default_options,
            is_default=make_default,
        )
        session.add(existing)
    else:
        existing.label = clean_label
        existing.provider = payload.provider
        existing.base_url = base_url
        existing.model_name = payload.model_name
        existing.default_options = payload.default_options
        existing.is_default = make_default
        if payload.api_key:
            existing.encrypted_api_key = encrypt_secret(payload.api_key, settings)

    await session.flush()
    await _audit_event(
        session, user_id, "image_config.saved", "image_model_config", str(existing.id)
    )
    await session.commit()
    await session.refresh(existing)
    return existing


@router.get("/agent/image-configs", response_model=list[ImageModelConfigOut])
async def list_image_configs(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[ImageModelConfigOut]:
    rows = await session.scalars(
        select(ImageModelConfig)
        .where(ImageModelConfig.owner_id == user.id)
        .order_by(ImageModelConfig.is_default.desc(), ImageModelConfig.updated_at.desc())
    )
    return [_image_config_out(row) for row in rows]


@router.post(
    "/agent/image-configs",
    response_model=ImageModelConfigOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_image_config(
    payload: ImageModelConfigInput,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ImageModelConfigOut:
    saved = await _save_image_config_row(
        session=session,
        user_id=user.id,
        payload=payload,
        settings=request.app.state.settings,
        upsert_default_when_untargeted=False,
    )
    return _image_config_out(saved)


@router.put("/agent/image-configs/{config_id}", response_model=ImageModelConfigOut)
async def update_image_config(
    config_id: uuid.UUID,
    payload: ImageModelConfigInput,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ImageModelConfigOut:
    saved = await _save_image_config_row(
        session=session,
        user_id=user.id,
        payload=payload,
        settings=request.app.state.settings,
        target_id=config_id,
    )
    return _image_config_out(saved)


@router.delete("/agent/image-configs/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_image_config(
    config_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    row = await session.scalar(
        select(ImageModelConfig).where(
            ImageModelConfig.owner_id == user.id, ImageModelConfig.id == config_id
        )
    )
    if row is None:
        raise not_found("未找到指定的生图配置")
    was_default = row.is_default
    await session.delete(row)
    await session.flush()
    if was_default:
        replacement = await session.scalar(
            select(ImageModelConfig)
            .where(ImageModelConfig.owner_id == user.id)
            .order_by(ImageModelConfig.updated_at.desc())
        )
        if replacement is not None:
            replacement.is_default = True
    await _audit_event(
        session, user.id, "image_config.deleted", "image_model_config", str(config_id)
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/agent/image-config", response_model=ImageModelConfigOut)
async def get_image_config(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ImageModelConfigOut:
    config = await session.scalar(
        select(ImageModelConfig)
        .where(ImageModelConfig.owner_id == user.id)
        .order_by(ImageModelConfig.is_default.desc(), ImageModelConfig.updated_at.desc())
    )
    if config is None:
        return ImageModelConfigOut(
            id=None,
            label="",
            provider="openai-compatible",
            base_url="",
            model_name="",
            default_options={},
            is_default=True,
            configured=False,
        )
    return _image_config_out(config)


@router.put("/agent/image-config", response_model=ImageModelConfigOut)
async def save_image_config(
    payload: ImageModelConfigInput,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ImageModelConfigOut:
    saved = await _save_image_config_row(
        session=session,
        user_id=user.id,
        payload=payload,
        settings=request.app.state.settings,
        upsert_default_when_untargeted=True,
    )
    return _image_config_out(saved)


@router.post("/agent/image-config/test")
async def test_image_config(
    payload: ImageModelConfigInput,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """验证生图接口地址与 API Key 鉴权状态，绝不保存或回显密钥。"""
    await enforce_rate_limit(
        request.app.state.redis,
        "provider_test",
        str(user.id),
        limit=request.app.state.settings.auth_rate_limit_per_minute,
    )
    api_key = payload.api_key
    if not api_key and payload.id is not None:
        saved = await session.scalar(
            select(ImageModelConfig).where(
                ImageModelConfig.owner_id == user.id, ImageModelConfig.id == payload.id
            )
        )
        if saved is not None:
            api_key = decrypt_secret(saved.encrypted_api_key, request.app.state.settings)
    if payload.provider == "mock":
        await MockImageProvider(default_model=payload.model_name, latency_ms=0).generate(
            ImageGenerationRequest(
                user_id=user.id,
                prompt="healthcheck",
                model=payload.model_name,
                reference_asset_ids=(),
                quality="auto",
                width=512,
                height=512,
                align_to_16=True,
                resolution="auto",
                aspect_ratio="1:1",
                transparent=False,
                count=1,
            )
        )
        return {"ok": True, "message": "内置 Mock 生图适配器就绪（无需 API Key）"}
    if not api_key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "测试连接需要提供 API 密钥")
    try:
        base_url = await asyncio.to_thread(validate_public_https_url, payload.base_url)
        await ConfiguredImageProvider(
            provider=payload.provider,
            base_url=base_url,
            api_key=api_key,
            default_model=payload.model_name,
        ).test_connection()
    except ValueError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error
    except ImageProviderError as error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(error)) from error
    except Exception:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "无法连接生图服务，请检查地址与网络"
        ) from None
    return {"ok": True, "message": "生图服务鉴权与连接测试通过"}


@router.post("/generations")
async def request_image_generation(
    payload: GenerationRequest,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    reference_assets: list[Asset] = []
    if payload.reference_asset_ids:
        reference_assets = list(
            await session.scalars(
                select(Asset).where(
                    Asset.owner_id == user.id, Asset.id.in_(payload.reference_asset_ids)
                )
            )
        )
        if len(reference_assets) != len(set(payload.reference_asset_ids)):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "参考图片必须属于当前账户")
    provider = await resolve_user_image_provider(
        session,
        user.id,
        request.app.state.settings,
        fallback=request.app.state.image_provider,
        requested_model=payload.model,
        config_id=payload.config_id,
    )
    storage: ObjectStorage = request.app.state.object_storage
    reference_images = []
    # Preserve exact user-selected reference order (图1, 图2, 图3...)
    asset_map = {asset.id: asset for asset in reference_assets}
    for ref_id in payload.reference_asset_ids:
        asset = asset_map[ref_id]
        reference_images.append(
            ReferenceImage(
                asset_id=asset.id,
                mime_type=asset.mime_type,
                content=await storage.get(asset.object_key),
            )
        )
    provider_request = ImageGenerationRequest(
        user_id=user.id,
        prompt=payload.prompt,
        model=payload.model,
        reference_asset_ids=tuple(payload.reference_asset_ids),
        quality=payload.quality,
        width=payload.width,
        height=payload.height,
        align_to_16=payload.align_to_16,
        resolution=payload.resolution,
        aspect_ratio=payload.aspect_ratio,
        transparent=payload.transparent,
        count=payload.count,
        reference_images=tuple(reference_images),
        input_fidelity=payload.input_fidelity,
        max_image_bytes=request.app.state.settings.max_upload_bytes,
    )
    try:
        generated = await provider.generate(provider_request)
    except ImageProviderNotConfigured as error:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from error
    except ImageProviderError as error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(error)[:240]) from None
    if not generated or len(generated) > payload.count:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "生图服务返回的图片数量无效")
    try:
        saved = await persist_generated_images(
            session,
            storage,
            user.id,
            generated,
            request.app.state.settings.max_upload_bytes,
            temporary=True,
            name_prefix=payload.prompt.strip()[:24] or "AI 生成图",
        )
    except ImageProviderError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "生图服务返回了无效图片") from None
    await _audit_event(
        session,
        user.id,
        "image.generated",
        "asset_batch",
        details={"count": len(saved)},
    )
    await session.commit()
    return {"status": "succeeded", "images": [_asset_out(asset) for asset in saved]}


@router.get("/agent/tools")
async def list_agent_tools(user: User = Depends(current_user)) -> dict:
    del user
    return {"tools": public_tool_specs()}


def _agent_run_out(run: AgentRun, tasks: list[AgentTask]) -> AgentRunOut:
    return AgentRunOut(
        id=run.id,
        canvas_id=run.canvas_id,
        goal=run.goal,
        status=run.status.value if isinstance(run.status, RunStatus) else run.status,
        context_revision=run.context_revision,
        model_calls_used=run.model_calls_used,
        model_call_budget=run.model_call_budget,
        completion_tokens_used=run.completion_tokens_used,
        completion_usage_reports=run.completion_usage_reports,
        completion_tokens_per_call=run.completion_tokens_per_call,
        summary=run.summary,
        proposal=run.proposal,
        error=run.error,
        harness_options=run.harness_options,
        tasks=[
            AgentTaskOut(
                id=t.id,
                role=t.role,
                sequence=t.sequence,
                task_key=t.task_key,
                title=t.title,
                depends_on=t.depends_on or [],
                status=t.status.value if isinstance(t.status, RunStatus) else t.status,
                output=t.output,
                error=t.error,
            )
            for t in tasks
        ],
        created_at=_iso(run.created_at),
        updated_at=_iso(run.updated_at),
    )


async def _append_event(
    session: AsyncSession, run_id: uuid.UUID, event_type: str, data: dict
) -> None:
    await session.scalar(select(AgentRun.id).where(AgentRun.id == run_id).with_for_update())
    sequence = await session.scalar(
        select(func.max(RunEvent.sequence)).where(RunEvent.run_id == run_id)
    )
    session.add(
        RunEvent(run_id=run_id, sequence=(sequence or 0) + 1, event_type=event_type, data=data)
    )


@router.post("/agent/runs", response_model=AgentRunOut, status_code=status.HTTP_202_ACCEPTED)
async def create_agent_run(
    payload: AgentRunCreate,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AgentRunOut:
    canvas = await _owned_canvas(session, user.id, payload.canvas_id)
    if payload.idempotency_key:
        existing = await session.scalar(
            select(AgentRun).where(
                AgentRun.idempotency_key == f"{user.id}:{payload.idempotency_key}"
            )
        )
        if existing:
            if existing.canvas_id != payload.canvas_id or existing.goal != payload.goal.strip():
                raise HTTPException(status.HTTP_409_CONFLICT, "幂等键与已有任务参数不一致")
            tasks = list(
                await session.scalars(
                    select(AgentTask)
                    .where(AgentTask.run_id == existing.id)
                    .order_by(AgentTask.sequence)
                )
            )
            return _agent_run_out(existing, tasks)
    await _enforce_active_run_limit(
        session, user.id, request.app.state.settings.max_active_agent_runs_per_user
    )
    asset_ids = set(payload.reference_asset_ids)
    if asset_ids:
        owned_ids = set(
            await session.scalars(
                select(Asset.id).where(Asset.owner_id == user.id, Asset.id.in_(asset_ids))
            )
        )
        if owned_ids != asset_ids:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "参考图片必须属于当前账户")
    idempotency_key = f"{user.id}:{payload.idempotency_key}" if payload.idempotency_key else None
    run = AgentRun(
        owner_id=user.id,
        project_id=canvas.project_id,
        canvas_id=canvas.id,
        goal=payload.goal.strip(),
        reference_asset_ids=[str(asset_id) for asset_id in payload.reference_asset_ids],
        generation_settings=(
            payload.generation_settings.model_dump(mode="json")
            if payload.generation_settings
            else None
        ),
        harness_options=(
            payload.harness_options.model_dump(mode="json")
            if payload.harness_options
            else None
        ),
        context_revision=canvas.revision,
        model_call_budget=request.app.state.settings.max_agent_model_calls_per_run,
        completion_tokens_per_call=request.app.state.settings.agent_model_completion_tokens_per_call,
        status=RunStatus.QUEUED,
        idempotency_key=idempotency_key,
    )
    session.add(run)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        if idempotency_key:
            existing = await session.scalar(
                select(AgentRun).where(AgentRun.idempotency_key == idempotency_key)
            )
            if existing:
                tasks = list(
                    await session.scalars(
                        select(AgentTask)
                        .where(AgentTask.run_id == existing.id)
                        .order_by(AgentTask.sequence)
                    )
                )
                return _agent_run_out(existing, tasks)
        raise
    is_generation = run.generation_settings is not None
    tasks = [
        AgentTask(
            run_id=run.id,
            role="Image Creator" if is_generation else "Coordinator",
            sequence=0,
            task_key="image_creator" if is_generation else "coordinator",
            title="生成图片" if is_generation else "拆解创作目标",
            depends_on=[],
            status=RunStatus.QUEUED,
        )
    ]
    session.add_all(tasks)
    await _audit_event(
        session,
        user.id,
        "agent_run.created",
        "agent_run",
        str(run.id),
        {"kind": "image_generation" if is_generation else "canvas_proposal"},
    )
    await _append_event(session, run.id, "queued", {"status": "queued", "goal": run.goal})
    await session.commit()
    queue = await get_redis_pool(request.app)
    if queue is None:
        run.status = RunStatus.FAILED
        run.error = "后台任务队列未启用"
        for task in tasks:
            task.status = RunStatus.FAILED
            task.error = run.error
        await _append_event(session, run.id, "failed", {"status": "failed", "error": run.error})
        await session.commit()
    else:
        try:
            await queue.enqueue_job("execute_agent_run", str(run.id), _job_id=f"agent-run:{run.id}")
        except Exception:
            run.status = RunStatus.FAILED
            run.error = "任务队列暂不可用，请稍后重试。"
            for task in tasks:
                task.status = RunStatus.FAILED
                task.error = run.error
            await _append_event(session, run.id, "failed", {"status": "failed", "error": run.error})
            await session.commit()
    await session.refresh(run)
    return _agent_run_out(run, tasks)


@router.get("/agent/runs", response_model=list[AgentRunOut])
async def list_agent_runs(
    canvas_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[AgentRunOut]:
    await _owned_canvas(session, user.id, canvas_id)
    runs = await session.scalars(
        select(AgentRun)
        .where(AgentRun.owner_id == user.id, AgentRun.canvas_id == canvas_id)
        .order_by(AgentRun.created_at.desc())
        .limit(50)
    )
    output = []
    for run in runs:
        tasks = list(
            await session.scalars(
                select(AgentTask).where(AgentTask.run_id == run.id).order_by(AgentTask.sequence)
            )
        )
        output.append(_agent_run_out(run, tasks))
    return output


@router.get("/agent/runs/{run_id}", response_model=AgentRunOut)
async def get_agent_run(
    run_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AgentRunOut:
    run = await session.scalar(
        select(AgentRun).where(AgentRun.id == run_id, AgentRun.owner_id == user.id)
    )
    if run is None:
        raise not_found()
    tasks = list(
        await session.scalars(
            select(AgentTask).where(AgentTask.run_id == run.id).order_by(AgentTask.sequence)
        )
    )
    return _agent_run_out(run, tasks)


@router.get("/agent/runs/{run_id}/events")
async def agent_run_events(
    run_id: uuid.UUID,
    request: Request,
    after: int = 0,
) -> StreamingResponse:
    # Authenticate and authorize in a short-lived session so no DB pool connection
    # remains checked out while the SSE StreamingResponse stays open.
    async with request.app.state.session_factory() as auth_session:
        user = await resolve_user_from_token(
            auth_session, request.cookies.get(SESSION_COOKIE)
        )
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "请先登录")
        run = await auth_session.scalar(
            select(AgentRun.id).where(AgentRun.id == run_id, AgentRun.owner_id == user.id)
        )
        if run is None:
            raise not_found()

    async def stream():
        try:
            header_after = int(request.headers.get("Last-Event-ID", "0") or 0)
        except ValueError:
            header_after = 0
        cursor = max(after, header_after, 0)
        while not await request.is_disconnected():
            async with request.app.state.session_factory() as event_session:
                events = await event_session.scalars(
                    select(RunEvent)
                    .where(RunEvent.run_id == run_id, RunEvent.sequence > cursor)
                    .order_by(RunEvent.sequence)
                )
                rows = list(events)
                terminal = await event_session.scalar(
                    select(AgentRun.status).where(AgentRun.id == run_id)
                )
            for event in rows:
                cursor = event.sequence
                event_json = json.dumps(event.data, ensure_ascii=False)
                yield (f"id: {cursor}\nevent: {event.event_type}\ndata: {event_json}\n\n")
            if terminal in {
                RunStatus.SUCCEEDED,
                RunStatus.FAILED,
                RunStatus.CANCELED,
                "succeeded",
                "failed",
                "canceled",
            }:
                break
            if not rows:
                yield ": keep-alive\n\n"
                await asyncio.sleep(1)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/agent/runs/{run_id}/cancel", response_model=AgentRunOut)
async def cancel_agent_run(
    run_id: uuid.UUID,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AgentRunOut:
    run = await session.scalar(
        select(AgentRun).where(AgentRun.id == run_id, AgentRun.owner_id == user.id)
    )
    if run is None:
        raise not_found()
    active_statuses = (RunStatus.QUEUED, RunStatus.RUNNING)
    result = await session.execute(
        update(AgentRun)
        .where(
            AgentRun.id == run.id,
            AgentRun.owner_id == user.id,
            AgentRun.status.in_(active_statuses),
        )
        .values(status=RunStatus.CANCELED, error=None)
    )
    canceled = bool(result.rowcount)
    if canceled:
        await session.execute(
            update(AgentTask)
            .where(
                AgentTask.run_id == run.id,
                AgentTask.status.in_(active_statuses),
            )
            .values(status=RunStatus.CANCELED, error=None)
        )
        await _audit_event(session, user.id, "agent_run.canceled", "agent_run", str(run.id))
        await _append_event(session, run.id, "canceled", {"status": "canceled"})
        await session.commit()
        redis_pool = await get_redis_pool(request.app)
        if redis_pool is not None:
            try:
                await Job(f"agent-run:{run.id}", redis_pool).abort(
                    timeout=1.5,
                    poll_delay=0.1,
                )
            except TimeoutError:
                logger.info(
                    "Agent cancellation recorded; worker has not acknowledged run_id=%s", run.id
                )
            except Exception as error:
                logger.error(
                    "Agent cancellation recorded but ARQ abort failed run_id=%s error_type=%s",
                    run.id,
                    type(error).__name__,
                )

    await session.refresh(run)
    tasks = list(
        await session.scalars(
            select(AgentTask).where(AgentTask.run_id == run.id).order_by(AgentTask.sequence)
        )
    )
    return _agent_run_out(run, tasks)


@router.post(
    "/agent/runs/{run_id}/retry", response_model=AgentRunOut, status_code=status.HTTP_202_ACCEPTED
)
async def retry_agent_run(
    run_id: uuid.UUID,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AgentRunOut:
    original = await session.scalar(
        select(AgentRun).where(AgentRun.id == run_id, AgentRun.owner_id == user.id)
    )
    if original is None:
        raise not_found()
    if original.status not in {RunStatus.FAILED, "failed"}:
        raise HTTPException(status.HTTP_409_CONFLICT, "只有失败的运行可以重试")
    await _enforce_active_run_limit(
        session, user.id, request.app.state.settings.max_active_agent_runs_per_user
    )
    canvas = await _owned_canvas(session, user.id, original.canvas_id)
    new_run = AgentRun(
        owner_id=user.id,
        project_id=original.project_id,
        canvas_id=original.canvas_id,
        goal=original.goal,
        reference_asset_ids=original.reference_asset_ids,
        generation_settings=original.generation_settings,
        harness_options=original.harness_options,
        context_revision=canvas.revision,
        model_call_budget=original.model_call_budget,
        completion_tokens_per_call=original.completion_tokens_per_call,
        status=RunStatus.QUEUED,
    )
    session.add(new_run)
    await session.flush()
    is_generation = new_run.generation_settings is not None
    tasks = [
        AgentTask(
            run_id=new_run.id,
            role="Image Creator" if is_generation else "Coordinator",
            sequence=0,
            task_key="image_creator" if is_generation else "coordinator",
            title="生成图片" if is_generation else "拆解创作目标",
            depends_on=[],
            status=RunStatus.QUEUED,
        )
    ]
    session.add_all(tasks)
    await _audit_event(
        session,
        user.id,
        "agent_run.retried",
        "agent_run",
        str(new_run.id),
        {"retry_of": str(original.id)},
    )
    await _append_event(
        session, new_run.id, "queued", {"status": "queued", "retry_of": str(original.id)}
    )
    await session.commit()
    queue = await get_redis_pool(request.app)
    if queue is None:
        new_run.status = RunStatus.FAILED
        new_run.error = "任务队列暂不可用，请稍后重试。"
        for task in tasks:
            task.status = RunStatus.FAILED
            task.error = new_run.error
        await _append_event(
            session, new_run.id, "failed", {"status": "failed", "error": new_run.error}
        )
        await session.commit()
    else:
        try:
            await queue.enqueue_job(
                "execute_agent_run", str(new_run.id), _job_id=f"agent-run:{new_run.id}"
            )
        except Exception:
            new_run.status = RunStatus.FAILED
            new_run.error = "任务队列暂不可用，请稍后重试。"
            for task in tasks:
                task.status = RunStatus.FAILED
                task.error = new_run.error
            await _append_event(
                session, new_run.id, "failed", {"status": "failed", "error": new_run.error}
            )
            await session.commit()
    await session.refresh(new_run)
    return _agent_run_out(new_run, tasks)


async def _record_memory_rejection(
    session: AsyncSession, owner_id: uuid.UUID, canvas_id: uuid.UUID, note: str
) -> None:
    memory = await session.scalar(
        select(CanvasMemory).where(
            CanvasMemory.owner_id == owner_id, CanvasMemory.canvas_id == canvas_id
        )
    )
    if memory is None:
        memory = CanvasMemory(
            owner_id=owner_id,
            canvas_id=canvas_id,
            compacted_summary="",
            compacted_run_count=0,
            rejected_feedback=[note[:240]],
        )
        session.add(memory)
    else:
        feedback = [*(memory.rejected_feedback or []), note[:240]]
        memory.rejected_feedback = feedback[-8:]


@router.get("/canvases/{canvas_id}/memory", response_model=CanvasMemoryOut)
async def get_canvas_memory(
    canvas_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasMemoryOut:
    await _owned_canvas(session, user.id, canvas_id)
    memory = await session.scalar(
        select(CanvasMemory).where(
            CanvasMemory.owner_id == user.id, CanvasMemory.canvas_id == canvas_id
        )
    )
    cfg = await session.scalar(select(ModelConfig).where(ModelConfig.owner_id == user.id))
    max_tokens = (cfg.max_context_tokens if cfg else None) or 32768
    runs = list(
        await session.scalars(
            select(AgentRun)
            .where(
                AgentRun.owner_id == user.id,
                AgentRun.canvas_id == canvas_id,
                AgentRun.status == RunStatus.SUCCEEDED,
            )
            .order_by(AgentRun.created_at.asc())
        )
    )
    anchor = memory.last_compacted_run_id if memory else None
    recent_runs = runs
    if anchor:
        idx = next((i for i, r in enumerate(runs) if r.id == anchor), -1)
        if idx >= 0:
            recent_runs = runs[idx + 1 :]
    summary = memory.compacted_summary if memory else ""
    recent_chars = sum(len(r.goal) + len(r.summary or "") for r in recent_runs)
    est_tokens = max(
        memory.estimated_tokens if memory else 0,
        (len(summary) + recent_chars) // 3,
    )
    return CanvasMemoryOut(
        compacted_summary=summary,
        compacted_run_count=memory.compacted_run_count if memory else 0,
        recent_run_count=len(recent_runs),
        estimated_tokens=est_tokens,
        max_context_tokens=max_tokens,
        compaction_threshold_tokens=int(max_tokens * 0.65),
        rejected_feedback=list(memory.rejected_feedback or []) if memory else [],
    )


@router.delete("/canvases/{canvas_id}/memory", response_model=CanvasMemoryOut)
async def clear_canvas_memory(
    canvas_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasMemoryOut:
    await _owned_canvas(session, user.id, canvas_id)
    latest_run_id = await session.scalar(
        select(AgentRun.id)
        .where(AgentRun.owner_id == user.id, AgentRun.canvas_id == canvas_id)
        .order_by(AgentRun.created_at.desc())
        .limit(1)
    )
    memory = await session.scalar(
        select(CanvasMemory).where(
            CanvasMemory.owner_id == user.id, CanvasMemory.canvas_id == canvas_id
        )
    )
    if memory is None:
        memory = CanvasMemory(
            owner_id=user.id,
            canvas_id=canvas_id,
            compacted_summary="",
            compacted_run_count=0,
            last_compacted_run_id=latest_run_id,
            estimated_tokens=0,
            rejected_feedback=[],
        )
        session.add(memory)
    else:
        memory.compacted_summary = ""
        memory.compacted_run_count = 0
        memory.last_compacted_run_id = latest_run_id
        memory.estimated_tokens = 0
        memory.rejected_feedback = []
    await session.commit()
    cfg = await session.scalar(select(ModelConfig).where(ModelConfig.owner_id == user.id))
    max_tokens = (cfg.max_context_tokens if cfg else None) or 32768
    return CanvasMemoryOut(
        compacted_summary="",
        compacted_run_count=0,
        recent_run_count=0,
        estimated_tokens=0,
        max_context_tokens=max_tokens,
        compaction_threshold_tokens=int(max_tokens * 0.65),
        rejected_feedback=[],
    )


@router.post("/canvases/{canvas_id}/harness/inspect")
async def inspect_canvas_harness(
    canvas_id: uuid.UUID,
    payload: HarnessInspectRequest,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    canvas = await _owned_canvas(session, user.id, canvas_id)
    doc = canvas.document if isinstance(canvas.document, dict) else {}
    items = [item for item in (doc.get("items") or []) if isinstance(item, dict)]
    ops = payload.operations or []
    try:
        validated_ops = validate_plan(ops, items, allow_result=True) if ops else []
    except PlanValidationError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error

    layout_report = verify_proposal_layout(items, validated_ops)
    mem_out = await get_canvas_memory(canvas_id, user=user, session=session)
    canvas_brief = [
        {
            "id": it.get("id"),
            "type": it.get("type"),
            "x": it.get("x"),
            "y": it.get("y"),
            "width": it.get("width"),
            "height": it.get("height"),
            "title": str(it.get("title") or "")[:80],
        }
        for it in items
    ]
    brief_tokens = len(json.dumps(canvas_brief, ensure_ascii=False)) // 3
    return {
        "canvas_id": str(canvas.id),
        "revision": canvas.revision,
        "item_count": len(items),
        "canvas_brief": canvas_brief,
        "token_breakdown": {
            "memory_estimated_tokens": mem_out.estimated_tokens,
            "canvas_brief_tokens": brief_tokens,
            "total_estimated_tokens": mem_out.estimated_tokens + brief_tokens,
            "compaction_threshold_tokens": mem_out.compaction_threshold_tokens,
            "max_context_tokens": mem_out.max_context_tokens,
            "utilization_pct": round(
                min(
                    100.0,
                    ((mem_out.estimated_tokens + brief_tokens) / max(1, mem_out.max_context_tokens))
                    * 100,
                ),
                1,
            ),
        },
        "memory": mem_out.model_dump(mode="json"),
        "layout_verification": layout_report,
    }


@router.post("/canvases/{canvas_id}/memory/compact", response_model=CanvasMemoryOut)
async def compact_canvas_memory_now(
    canvas_id: uuid.UUID,
    payload: MemoryCompactRequest,
    request: Request,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasMemoryOut:
    await _owned_canvas(session, user.id, canvas_id)
    memory = await session.scalar(
        select(CanvasMemory)
        .where(CanvasMemory.owner_id == user.id, CanvasMemory.canvas_id == canvas_id)
        .with_for_update()
    )
    cfg = await session.scalar(select(ModelConfig).where(ModelConfig.owner_id == user.id))
    max_tokens = (cfg.max_context_tokens if cfg else None) or 32768
    runs = list(
        await session.scalars(
            select(AgentRun)
            .where(
                AgentRun.owner_id == user.id,
                AgentRun.canvas_id == canvas_id,
                AgentRun.status == RunStatus.SUCCEEDED,
            )
            .order_by(AgentRun.created_at.asc())
        )
    )
    anchor = memory.last_compacted_run_id if memory else None
    recent_runs = runs
    if anchor:
        idx = next((i for i, r in enumerate(runs) if r.id == anchor), -1)
        if idx >= 0:
            recent_runs = runs[idx + 1 :]

    if not recent_runs:
        return await get_canvas_memory(canvas_id, user=user, session=session)

    keep_tail = 1 if len(recent_runs) >= 2 else 0
    to_compact = recent_runs[:-keep_tail] if keep_tail else recent_runs
    tail_runs = recent_runs[-keep_tail:] if keep_tail else []
    prev_summary = memory.compacted_summary if memory else ""
    rejected = list(memory.rejected_feedback or []) if memory else []

    turn_lines = [
        f"- 目标: {r.goal[:80]} | 结果: {(r.summary or '已完成')[:100]}"
        for r in to_compact
    ]
    new_core = prev_summary
    if payload.llm_mode == "real" and cfg is not None:
        chat_provider = OpenAICompatibleChatProvider()
        try:
            compacted_res = await chat_provider.complete_json(
                base_url=cfg.base_url,
                api_key=decrypt_secret(cfg.encrypted_api_key, request.app.state.settings),
                model=cfg.model_name,
                system=(
                    "你是 FlowCanvas Harness Memory Compactor。"
                    "请把给定历史轮次与现有 core_memory 蒸馏为 400 字以内中文核心记忆，"
                    '仅返回 JSON：{"core_memory":"..."}。'
                ),
                user=json.dumps(
                    {
                        "previous_core_memory": prev_summary,
                        "rejected_patterns": rejected,
                        "turns": turn_lines,
                    },
                    ensure_ascii=False,
                ),
                max_output_tokens=800,
                token_limit_field=request.app.state.settings.chat_completion_token_limit_field,
            )
            new_core = str(compacted_res.content.get("core_memory") or "").strip()
        except ProviderError:
            new_core = ""
    if not new_core:
        merged = [seg for seg in (prev_summary, *turn_lines) if seg]
        if rejected:
            merged.append("已否决方向：" + "；".join(rejected[-3:]))
        new_core = "\n".join(merged)[-900:]

    tail_chars = sum(len(r.goal) + len(r.summary or "") for r in tail_runs)
    est_tokens = (len(new_core) + tail_chars) // 3
    if memory is None:
        memory = CanvasMemory(
            owner_id=user.id,
            canvas_id=canvas_id,
            compacted_summary=new_core,
            compacted_run_count=len(to_compact),
            last_compacted_run_id=to_compact[-1].id,
            estimated_tokens=est_tokens,
            rejected_feedback=rejected,
        )
        session.add(memory)
    else:
        memory.compacted_summary = new_core
        memory.compacted_run_count = (memory.compacted_run_count or 0) + len(to_compact)
        memory.last_compacted_run_id = to_compact[-1].id
        memory.estimated_tokens = est_tokens
    await session.commit()
    return CanvasMemoryOut(
        compacted_summary=memory.compacted_summary,
        compacted_run_count=memory.compacted_run_count,
        recent_run_count=len(tail_runs),
        estimated_tokens=est_tokens,
        max_context_tokens=max_tokens,
        compaction_threshold_tokens=int(max_tokens * 0.65),
        rejected_feedback=rejected,
    )


@router.post("/agent/runs/{run_id}/apply", response_model=CanvasOut)
async def apply_agent_proposal(
    run_id: uuid.UUID,
    payload: ApplyProposal,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasOut:
    run = await session.scalar(
        select(AgentRun)
        .where(AgentRun.id == run_id, AgentRun.owner_id == user.id)
        .with_for_update()
    )
    if run is None:
        raise not_found()
    if not run.proposal or run.status not in {RunStatus.SUCCEEDED, "succeeded"}:
        raise HTTPException(status.HTTP_409_CONFLICT, "当前运行没有可应用的提案")
    if run.proposal.get("applied"):
        raise HTTPException(status.HTTP_409_CONFLICT, "该提案已经应用")
    if run.proposal.get("rejected"):
        raise HTTPException(status.HTTP_409_CONFLICT, "该提案已被忽略，请重新发起运行")
    canvas = await _owned_canvas(session, user.id, run.canvas_id)
    if payload.base_revision != canvas.revision or canvas.revision != run.context_revision:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "revision_conflict",
                "current_revision": canvas.revision,
                "message": "画布已更新，请基于最新版本重新生成提案。",
            },
        )
    raw_doc = CanvasDocument.model_validate(canvas.document)
    items = [item.model_dump(mode="json") for item in raw_doc.items]
    operations = validate_plan(run.proposal.get("operations"), items, allow_result=True)
    result_asset_ids: set[uuid.UUID] = set()
    mutated_ids: set[str] = set()
    for operation in operations:
        tool_name = operation["tool"]
        params = operation["params"]
        if tool_name in {"generate_image", "edit_image"}:
            res = operation.get("result") or {}
            if not res.get("asset_id"):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "提案生图结果不完整")
            result_asset_ids.add(uuid.UUID(str(res["asset_id"])))
        elif tool_name in {"move_object", "resize_object"}:
            mutated_ids.add(params["object_id"])
        elif tool_name == "align_objects":
            mutated_ids.update(params["object_ids"])

    if result_asset_ids:
        owned_result_ids = set(
            await session.scalars(
                select(Asset.id).where(Asset.owner_id == user.id, Asset.id.in_(result_asset_ids))
            )
        )
        if result_asset_ids != owned_result_ids:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "提案引用了未授权的图片素材")

    before_ids = {item["id"] for item in items}
    before_items = [dict(item) for item in items if item["id"] in mutated_ids]

    for operation in operations:
        apply_canvas_operation(items, operation, new_id=f"agent-{uuid.uuid4()}")
    added_item_ids = [item["id"] for item in items if item["id"] not in before_ids]

    next_document = CanvasDocument(schema_version=raw_doc.schema_version, items=items)
    previous_revision = canvas.revision
    previous_document = canvas.document
    previous_viewport = canvas.viewport
    result = await session.execute(
        update(Canvas)
        .where(Canvas.id == canvas.id, Canvas.revision == payload.base_revision)
        .values(
            document=next_document.model_dump(mode="json"),
            schema_version=next_document.schema_version,
            revision=Canvas.revision + 1,
            updated_at=func.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.rollback()
        current = await _owned_canvas(session, user.id, canvas.id)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "revision_conflict",
                "current_revision": current.revision,
                "message": "画布已更新，请基于最新版本重新生成提案。",
            },
        )
    await _record_canvas_version(
        session, canvas.id, previous_revision, previous_document, previous_viewport, force=True
    )
    next_revision = previous_revision + 1
    run.proposal = {
        **run.proposal,
        "applied": True,
        "audit_undo": {"added_item_ids": added_item_ids, "before_items": before_items},
    }
    await _append_event(
        session, run.id, "applied", {"status": "succeeded", "canvas_revision": next_revision}
    )
    await _audit_event(
        session,
        user.id,
        "agent_proposal.applied",
        "agent_run",
        str(run.id),
        {
            "canvas_id": str(canvas.id),
            "canvas_revision": next_revision,
            "operation_count": len(operations),
        },
    )
    await session.commit()
    session.expire(canvas)
    await session.refresh(canvas)
    return _canvas_out(canvas)


@router.post("/agent/runs/{run_id}/revert", response_model=CanvasOut)
async def revert_agent_proposal(
    run_id: uuid.UUID,
    payload: ApplyProposal,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CanvasOut:
    """精准回退某一批已应用提案（移除生成的元素并还原受影响对象，不影响后续其他修改）。"""
    run = await session.scalar(
        select(AgentRun)
        .where(AgentRun.id == run_id, AgentRun.owner_id == user.id)
        .with_for_update()
    )
    if run is None:
        raise not_found()
    if not run.proposal or not run.proposal.get("applied"):
        raise HTTPException(status.HTTP_409_CONFLICT, "该提案尚未应用，无需回退")
    if run.proposal.get("reverted"):
        raise HTTPException(status.HTTP_409_CONFLICT, "该提案已回退")

    canvas = await _owned_canvas(session, user.id, run.canvas_id)
    if payload.base_revision != canvas.revision:
        raise _revision_conflict(canvas)

    undo_info = run.proposal.get("audit_undo") or {}
    added_ids = set(undo_info.get("added_item_ids") or [])
    before_map = {item["id"]: item for item in (undo_info.get("before_items") or [])}

    raw_doc = CanvasDocument.model_validate(canvas.document)
    items = [item.model_dump(mode="json") for item in raw_doc.items]
    reverted_items = [before_map.get(it["id"], it) for it in items if it["id"] not in added_ids]
    next_document = CanvasDocument(schema_version=raw_doc.schema_version, items=reverted_items)

    previous_revision = canvas.revision
    previous_document = canvas.document
    previous_viewport = canvas.viewport
    result = await session.execute(
        update(Canvas)
        .where(Canvas.id == canvas.id, Canvas.revision == payload.base_revision)
        .values(
            document=next_document.model_dump(mode="json"),
            schema_version=next_document.schema_version,
            revision=Canvas.revision + 1,
            updated_at=func.now(),
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.rollback()
        raise _revision_conflict(await _owned_canvas(session, user.id, canvas.id))

    await _record_canvas_version(
        session, canvas.id, previous_revision, previous_document, previous_viewport, force=True
    )
    next_revision = previous_revision + 1
    run.proposal = {**run.proposal, "reverted": True}
    await _record_memory_rejection(
        session,
        user.id,
        canvas.id,
        f"用户回退了指令「{run.goal[:40]}」的方案（{run.summary or '提案'}），勿重复采用。",
    )
    await _append_event(
        session, run.id, "reverted", {"status": "succeeded", "canvas_revision": next_revision}
    )
    await _audit_event(session, user.id, "agent_proposal.reverted", "agent_run", str(run.id))
    await session.commit()
    session.expire(canvas)
    await session.refresh(canvas)
    return _canvas_out(canvas)


@router.post("/agent/runs/{run_id}/reject", response_model=AgentRunOut)
async def reject_agent_proposal(
    run_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_db_session),
) -> AgentRunOut:
    run = await session.scalar(
        select(AgentRun)
        .where(AgentRun.id == run_id, AgentRun.owner_id == user.id)
        .with_for_update()
    )
    if run is None:
        raise not_found()
    if run.proposal and run.proposal.get("applied"):
        raise HTTPException(status.HTTP_409_CONFLICT, "该提案已应用，如需撤销请使用回退功能")
    if run.proposal and not run.proposal.get("rejected"):
        run.proposal = {**run.proposal, "rejected": True}
        await _record_memory_rejection(
            session,
            user.id,
            run.canvas_id,
            f"用户否决了指令「{run.goal[:40]}」的方案（{run.summary or '提案'}），请换方向。",
        )
        await _audit_event(session, user.id, "agent_proposal.rejected", "agent_run", str(run.id))
        await _append_event(session, run.id, "rejected", {"status": "succeeded"})
        await session.commit()
    tasks = list(
        await session.scalars(
            select(AgentTask).where(AgentTask.run_id == run.id).order_by(AgentTask.sequence)
        )
    )
    return _agent_run_out(run, tasks)
