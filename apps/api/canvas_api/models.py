from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JSON_DOCUMENT = JSON().with_variant(JSONB(), "postgresql")


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class UUIDModel(Base):
    __abstract__ = True

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class User(UUIDModel):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(String(24), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))


class UserSession(UUIDModel):
    __tablename__ = "sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(48), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict] = mapped_column(JSON_DOCUMENT, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False, index=True
    )


class Project(UUIDModel):
    __tablename__ = "projects"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))


class Canvas(UUIDModel):
    __tablename__ = "canvases"

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    document: Mapped[dict] = mapped_column(JSON_DOCUMENT, default=dict)
    viewport: Mapped[dict] = mapped_column(JSON_DOCUMENT, default=dict)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    revision: Mapped[int] = mapped_column(Integer, default=0)


class CanvasVersion(UUIDModel):
    __tablename__ = "canvas_versions"
    __table_args__ = (UniqueConstraint("canvas_id", "revision", name="uq_canvas_revision"),)

    canvas_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("canvases.id", ondelete="CASCADE"), index=True
    )
    revision: Mapped[int] = mapped_column(Integer)
    document: Mapped[dict] = mapped_column(JSON_DOCUMENT)
    viewport: Mapped[dict] = mapped_column(JSON_DOCUMENT)


class Asset(UUIDModel):
    __tablename__ = "assets"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    object_key: Mapped[str] = mapped_column(String(512), unique=True)
    mime_type: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    temporary: Mapped[bool] = mapped_column(Boolean, default=False, index=True)


class ModelConfig(UUIDModel):
    __tablename__ = "model_configs"
    __table_args__ = (UniqueConstraint("owner_id", name="uq_model_config_owner"),)

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(48), default="openai-compatible")
    base_url: Mapped[str] = mapped_column(String(500))
    model_name: Mapped[str] = mapped_column(String(160))
    encrypted_api_key: Mapped[str] = mapped_column(Text)
    role_models: Mapped[dict] = mapped_column(JSON_DOCUMENT, default=dict)
    max_context_tokens: Mapped[int] = mapped_column(Integer, default=32768)


class ImageModelConfig(UUIDModel):
    __tablename__ = "image_model_configs"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    label: Mapped[str] = mapped_column(String(80), default="")
    provider: Mapped[str] = mapped_column(String(48), default="openai-compatible")
    base_url: Mapped[str] = mapped_column(String(500))
    model_name: Mapped[str] = mapped_column(String(160))
    encrypted_api_key: Mapped[str] = mapped_column(Text)
    default_options: Mapped[dict] = mapped_column(JSON_DOCUMENT, default=dict)
    is_default: Mapped[bool] = mapped_column(Boolean, default=True)


class CanvasMemory(UUIDModel):
    """Harness-style persistent & compacted per-canvas agent context memory."""

    __tablename__ = "canvas_memories"
    __table_args__ = (UniqueConstraint("canvas_id", name="uq_canvas_memory_canvas"),)

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    canvas_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("canvases.id", ondelete="CASCADE"), index=True
    )
    compacted_summary: Mapped[str] = mapped_column(Text, default="")
    compacted_run_count: Mapped[int] = mapped_column(Integer, default=0)
    last_compacted_run_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), default=None
    )
    estimated_tokens: Mapped[int] = mapped_column(Integer, default=0)
    rejected_feedback: Mapped[list] = mapped_column(JSON_DOCUMENT, default=list)


class RunStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


class AgentRun(UUIDModel):
    __tablename__ = "agent_runs"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    canvas_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("canvases.id", ondelete="CASCADE"), index=True
    )
    goal: Mapped[str] = mapped_column(Text)
    reference_asset_ids: Mapped[list] = mapped_column(JSON_DOCUMENT, default=list)
    generation_settings: Mapped[dict | None] = mapped_column(JSON_DOCUMENT, default=None)
    context_revision: Mapped[int] = mapped_column(Integer)
    model_calls_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    model_call_budget: Mapped[int] = mapped_column(Integer, default=12, nullable=False)
    completion_tokens_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_usage_reports: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens_per_call: Mapped[int] = mapped_column(Integer, default=2048, nullable=False)
    status: Mapped[RunStatus] = mapped_column(String(24), default=RunStatus.QUEUED)
    summary: Mapped[str | None] = mapped_column(Text, default=None)
    proposal: Mapped[dict | None] = mapped_column(JSON_DOCUMENT, default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    idempotency_key: Mapped[str | None] = mapped_column(String(165), unique=True, default=None)


class AgentTask(UUIDModel):
    __tablename__ = "agent_tasks"
    __table_args__ = (
        UniqueConstraint("run_id", "task_key", name="uq_agent_task_key"),
        UniqueConstraint("run_id", "sequence", name="uq_agent_task_sequence"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(48))
    sequence: Mapped[int] = mapped_column(Integer)
    task_key: Mapped[str] = mapped_column(String(48), default="")
    title: Mapped[str] = mapped_column(String(160), default="")
    depends_on: Mapped[list] = mapped_column(JSON_DOCUMENT, default=list)
    status: Mapped[RunStatus] = mapped_column(String(24), default=RunStatus.QUEUED)
    output: Mapped[dict | None] = mapped_column(JSON_DOCUMENT, default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class RunEvent(UUIDModel):
    __tablename__ = "run_events"
    __table_args__ = (UniqueConstraint("run_id", "sequence", name="uq_run_event_sequence"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(48))
    data: Mapped[dict] = mapped_column(JSON_DOCUMENT, default=dict)
