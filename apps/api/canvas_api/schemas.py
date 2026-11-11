from __future__ import annotations

import re
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserCreate(APIModel):
    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def username_format(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9_]{3,24}", value):
            raise ValueError("用户名须为 3–24 个字母、数字或下划线")
        return value


class LoginRequest(APIModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=128)


class PasswordChange(APIModel):
    current_password: str = Field(min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UserOut(APIModel):
    id: uuid.UUID
    username: str


class ProjectCreate(APIModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectUpdate(APIModel):
    name: str = Field(min_length=1, max_length=120)


class ProjectOut(APIModel):
    id: uuid.UUID
    name: str
    updated_at: str


class CanvasCreate(APIModel):
    project_id: uuid.UUID | None = None
    name: str = Field(default="未命名画布", min_length=1, max_length=120)


class Viewport(APIModel):
    x: float = 0
    y: float = 0
    scale: float = Field(default=1, ge=0.1, le=8)


class CanvasItem(APIModel):
    id: str = Field(min_length=1, max_length=128)
    type: Literal["image", "note", "text", "swatch", "shape", "connector", "brush"]
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)
    width: float = Field(gt=0, le=100_000)
    height: float = Field(gt=0, le=100_000)
    title: str = Field(default="", max_length=500)
    content: str | None = Field(default=None, max_length=20_000)
    color: str | None = Field(default=None, max_length=32)
    font_family: Literal["sans", "serif", "mono"] | None = None
    font_size: float | None = Field(default=None, ge=8, le=200)
    stroke_width: float | None = Field(default=None, ge=1, le=64)
    shape_kind: Literal["rect", "circle", "frame"] | None = None
    points: list[float] | None = Field(default=None, max_length=20_000)
    visible: bool = True
    asset_id: uuid.UUID | None = None
    src: str | None = Field(default=None, max_length=1000)

    @field_validator("src")
    @classmethod
    def safe_source(cls, value: str | None) -> str | None:
        if value is not None and (value.startswith("data:") or value.startswith("blob:")):
            raise ValueError("画布文档不能保存临时或内嵌图片 URL")
        return value


class CanvasDocument(APIModel):
    schema_version: int = Field(default=1, ge=1)
    items: list[CanvasItem] = Field(default_factory=list, max_length=2000)

    @model_validator(mode="after")
    def unique_item_ids(self) -> CanvasDocument:
        ids = [item.id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("画布对象 id 不能重复")
        return self


class CanvasSave(APIModel):
    base_revision: int = Field(ge=0)
    document: CanvasDocument
    viewport: Viewport = Field(default_factory=Viewport)


class CanvasUpdate(APIModel):
    name: str = Field(min_length=1, max_length=120)


class CanvasOut(APIModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    document: dict
    viewport: dict
    schema_version: int
    revision: int
    updated_at: str


class CanvasVersionOut(APIModel):
    revision: int
    created_at: str
    schema_version: int
    object_count: int
    is_current: bool = False


class CanvasRestore(APIModel):
    base_revision: int = Field(ge=0)
    version_revision: int = Field(ge=0)


class AssetOut(APIModel):
    id: uuid.UUID
    name: str
    mime_type: str
    size_bytes: int
    width: int
    height: int
    favorite: bool
    temporary: bool = False
    src: str
    created_at: str


class FavoriteUpdate(APIModel):
    favorite: bool


class ModelConfigInput(APIModel):
    provider: Literal["openai-compatible"] = "openai-compatible"
    base_url: str = Field(min_length=8, max_length=500)
    model_name: str = Field(min_length=1, max_length=160)
    api_key: str | None = Field(default=None, min_length=8, max_length=1000)
    role_models: dict[str, str] = Field(default_factory=dict)
    max_context_tokens: int = Field(default=32768, ge=4096, le=1_000_000)

    @field_validator("role_models")
    @classmethod
    def valid_role_models(cls, value: dict[str, str]) -> dict[str, str]:
        allowed_roles = {"Coordinator", "Planner", "Canvas Editor", "Reviewer"}
        if set(value) - allowed_roles:
            raise ValueError("角色模型配置包含未知角色")
        cleaned = {role: model.strip() for role, model in value.items() if model.strip()}
        if any(len(model) > 160 for model in cleaned.values()):
            raise ValueError("角色模型名称不能超过 160 个字符")
        return cleaned


class ModelConfigOut(APIModel):
    provider: str
    base_url: str
    model_name: str
    role_models: dict[str, str] = Field(default_factory=dict)
    max_context_tokens: int = 32768
    configured: bool


class CanvasMemoryOut(APIModel):
    compacted_summary: str
    compacted_run_count: int
    recent_run_count: int
    estimated_tokens: int
    max_context_tokens: int
    compaction_threshold_tokens: int
    rejected_feedback: list[str] = Field(default_factory=list)


ImageProviderLiteral = Literal[
    "openai-compatible",
    "google-gemini",
    "dashscope",
    "volcengine-ark",
    "siliconflow",
]


class ImageModelConfigInput(APIModel):
    id: uuid.UUID | None = None
    label: str = Field(default="", max_length=80)
    provider: ImageProviderLiteral = "openai-compatible"
    base_url: str = Field(min_length=8, max_length=500)
    model_name: str = Field(min_length=1, max_length=160)
    api_key: str | None = Field(default=None, min_length=8, max_length=1000)
    default_options: dict = Field(default_factory=dict)
    is_default: bool = True


class ImageModelConfigOut(APIModel):
    id: uuid.UUID | None = None
    label: str = ""
    provider: str
    base_url: str
    model_name: str
    default_options: dict = Field(default_factory=dict)
    is_default: bool = True
    configured: bool


class ImageGenerationOptions(APIModel):
    model: str = Field(default="auto", min_length=1, max_length=160)
    quality: Literal["auto", "low", "medium", "high", "very_high", "maximum"] = "auto"
    width: int = Field(default=1024, ge=64, le=4096)
    height: int = Field(default=1024, ge=64, le=4096)
    align_to_16: bool = True
    resolution: Literal["1K", "2K", "4K", "auto"] = "auto"
    aspect_ratio: Literal[
        "1:1",
        "2:3",
        "3:2",
        "4:3",
        "3:4",
        "4:5",
        "5:4",
        "16:9",
        "9:16",
        "21:9",
        "9:21",
        "auto",
    ] = "auto"
    transparent: bool = False
    input_fidelity: Literal["high", "low"] = "high"
    count: int = Field(default=1, ge=1, le=10)

    @model_validator(mode="after")
    def validate_dimensions(self) -> ImageGenerationOptions:
        if self.align_to_16 and (self.width % 16 != 0 or self.height % 16 != 0):
            raise ValueError("启用 16 倍数对齐时，宽和高必须为 16 的倍数")
        return self


def _unique_reference_assets(value: list[uuid.UUID]) -> list[uuid.UUID]:
    if len(value) != len(set(value)):
        raise ValueError("参考图片不能重复")
    return value


class AgentRunCreate(APIModel):
    canvas_id: uuid.UUID
    goal: str = Field(min_length=1, max_length=4000)
    reference_asset_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    generation_settings: ImageGenerationOptions | None = None
    idempotency_key: str | None = Field(default=None, max_length=128)

    @field_validator("reference_asset_ids")
    @classmethod
    def unique_reference_assets(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        return _unique_reference_assets(value)


class AgentTaskOut(APIModel):
    id: uuid.UUID
    role: str
    sequence: int
    task_key: str
    title: str
    depends_on: list[str]
    status: str
    output: dict | None
    error: str | None


class AgentRunOut(APIModel):
    id: uuid.UUID
    canvas_id: uuid.UUID
    goal: str
    status: str
    context_revision: int
    model_calls_used: int
    model_call_budget: int
    completion_tokens_used: int
    completion_usage_reports: int
    completion_tokens_per_call: int
    summary: str | None
    proposal: dict | None
    error: str | None
    tasks: list[AgentTaskOut]
    created_at: str
    updated_at: str


class ApplyProposal(APIModel):
    base_revision: int = Field(ge=0)


class GenerationRequest(ImageGenerationOptions):
    config_id: uuid.UUID | None = None
    prompt: str = Field(min_length=1, max_length=4000)
    reference_asset_ids: list[uuid.UUID] = Field(default_factory=list, max_length=14)

    @field_validator("reference_asset_ids")
    @classmethod
    def unique_reference_assets(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        return _unique_reference_assets(value)
