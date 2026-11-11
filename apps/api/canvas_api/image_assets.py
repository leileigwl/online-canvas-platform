from __future__ import annotations

import hashlib
import io
import uuid

from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from canvas_api.config import Settings
from canvas_api.models import Asset, ImageModelConfig
from canvas_api.providers.images import (
    ConfiguredImageProvider,
    GeneratedImage,
    ImageGenerationProvider,
    ImageProviderError,
    UnconfiguredImageProvider,
)
from canvas_api.security import decrypt_secret
from canvas_api.storage import ObjectStorage

ALLOWED_IMAGE_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


def inspect_generated_image(content: bytes) -> tuple[str, int, int]:
    try:
        image = Image.open(io.BytesIO(content))
        mime_type = ALLOWED_IMAGE_FORMATS.get(image.format or "")
        width, height = image.size
        if mime_type is None:
            raise ImageProviderError("生图服务返回了不支持的图片格式")
        if width > 20_000 or height > 20_000 or width * height > 100_000_000:
            raise ImageProviderError("生图服务返回的图片尺寸超过限制")
        image.verify()
    except ImageProviderError:
        raise
    except Image.DecompressionBombError:
        raise ImageProviderError("生图服务返回的图片像素总量超过限制") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise ImageProviderError("生图服务返回了无效图片") from None
    return mime_type, width, height


async def persist_generated_images(
    session: AsyncSession,
    storage: ObjectStorage,
    owner_id: uuid.UUID,
    generated: list[GeneratedImage],
    max_upload_bytes: int,
    *,
    temporary: bool = True,
    name_prefix: str = "生成图片",
    commit: bool = True,
) -> list[Asset]:
    saved: list[Asset] = []
    stored_keys: list[str] = []
    try:
        for index, image in enumerate(generated, start=1):
            if not image.content or len(image.content) > max_upload_bytes:
                raise ImageProviderError("生图服务返回的文件大小无效")
            mime_type, width, height = inspect_generated_image(image.content)
            if mime_type != image.mime_type or width != image.width or height != image.height:
                raise ImageProviderError("生图服务返回的图片信息不匹配")
            suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime_type]
            object_key = f"{owner_id}/{uuid.uuid4()}{suffix}"
            await storage.put(object_key, image.content, mime_type)
            stored_keys.append(object_key)
            saved.append(
                Asset(
                    owner_id=owner_id,
                    name=f"{name_prefix} {index}",
                    object_key=object_key,
                    mime_type=mime_type,
                    size_bytes=len(image.content),
                    sha256=hashlib.sha256(image.content).hexdigest(),
                    width=width,
                    height=height,
                    temporary=temporary,
                )
            )
        session.add_all(saved)
        if commit:
            await session.commit()
        else:
            await session.flush()
    except Exception:
        await session.rollback()
        for object_key in stored_keys:
            await storage.delete(object_key)
        raise
    if commit:
        for asset in saved:
            await session.refresh(asset)
    return saved


def _infer_provider_for_model(model: str) -> str | None:
    lower = model.lower().strip()
    if not lower or lower == "auto":
        return None
    if lower.startswith(("gemini", "nano-banana", "imagen")):
        return "google-gemini"
    if lower.startswith(("qwen-image", "wan")):
        return "dashscope"
    if lower.startswith(("doubao-seedream", "seedream")):
        return "volcengine-ark"
    if lower.startswith(("kwai-kolors", "kolors", "black-forest-labs/", "qwen/qwen-image")):
        return "siliconflow"
    if lower.startswith(("gpt-image", "chatgpt-image", "dall-e")):
        return "openai-compatible"
    return None


async def resolve_user_image_provider(
    session: AsyncSession,
    owner_id: uuid.UUID,
    settings: Settings,
    fallback: ImageGenerationProvider | None = None,
    *,
    requested_model: str | None = None,
    config_id: uuid.UUID | None = None,
) -> ImageGenerationProvider:
    """Resolve user's encrypted BYOK image provider by id, model match, or default profile."""
    configs = list(
        await session.scalars(
            select(ImageModelConfig)
            .where(ImageModelConfig.owner_id == owner_id)
            .order_by(ImageModelConfig.is_default.desc(), ImageModelConfig.updated_at.desc())
        )
    )
    selected: ImageModelConfig | None = None
    if config_id is not None:
        selected = next((c for c in configs if c.id == config_id), None)
        if selected is None:
            return fallback or UnconfiguredImageProvider()
    elif configs:
        clean_req = (requested_model or "").strip().lower()
        if clean_req and clean_req != "auto":
            selected = next((c for c in configs if c.model_name.lower() == clean_req), None)
            if selected is None:
                inferred = _infer_provider_for_model(clean_req)
                if inferred is not None:
                    selected = next((c for c in configs if c.provider == inferred), None)
        if selected is None:
            selected = next((c for c in configs if c.is_default), configs[0])

    if selected is not None:
        return ConfiguredImageProvider(
            provider=selected.provider,
            base_url=selected.base_url,
            api_key=decrypt_secret(selected.encrypted_api_key, settings),
            default_model=selected.model_name,
        )
    return fallback or UnconfiguredImageProvider()
