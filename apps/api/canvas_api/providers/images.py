from __future__ import annotations

import asyncio
import base64
import io
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

import httpx
from PIL import Image, UnidentifiedImageError

from canvas_api.providers.chat import validate_public_https_url

ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
_EXT_BY_MIME = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


@dataclass(frozen=True)
class ReferenceImage:
    asset_id: UUID
    mime_type: str
    content: bytes


@dataclass(frozen=True)
class ImageGenerationRequest:
    user_id: UUID
    prompt: str
    model: str
    reference_asset_ids: tuple[UUID, ...]
    quality: str
    width: int
    height: int
    align_to_16: bool
    resolution: str
    aspect_ratio: str
    transparent: bool
    count: int
    reference_images: tuple[ReferenceImage, ...] = ()
    input_fidelity: str = "high"


@dataclass(frozen=True)
class GeneratedImage:
    content: bytes
    mime_type: str
    width: int
    height: int


class ImageGenerationProvider(Protocol):
    """Provider boundary shared by text-to-image and image-edit implementations."""

    async def generate(self, request: ImageGenerationRequest) -> list[GeneratedImage]: ...

    async def edit(self, request: ImageGenerationRequest) -> list[GeneratedImage]: ...


class ImageProviderError(RuntimeError):
    pass


class ImageProviderNotConfigured(ImageProviderError):
    pass


class UnconfiguredImageProvider:
    """Default adapter. It never fabricates a result or sends a network request."""

    async def generate(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        del request
        raise ImageProviderNotConfigured("当前没有配置生图服务，请前往「模型与生图设置」配置密钥")

    async def edit(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        del request
        raise ImageProviderNotConfigured("当前没有配置改图服务，请前往「模型与生图设置」配置密钥")


def _parse_image_bytes(raw: bytes) -> GeneratedImage:
    try:
        with Image.open(io.BytesIO(raw)) as img:
            mime_type = ALLOWED_FORMATS.get(img.format or "")
            if mime_type is None:
                # Re-encode non-standard formats (e.g. BMP/TIFF) cleanly as PNG.
                buf = io.BytesIO()
                img.convert("RGBA" if "A" in img.getbands() else "RGB").save(buf, format="PNG")
                raw = buf.getvalue()
                mime_type = "image/png"
            width, height = img.size
            if width <= 0 or height <= 0 or width > 20_000 or height > 20_000:
                raise ImageProviderError("生图服务返回的图片尺寸无效")
    except ImageProviderError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise ImageProviderError("无法解析生图服务返回的图片内容") from error
    return GeneratedImage(content=raw, mime_type=mime_type, width=width, height=height)


async def _fetch_image_url(client: httpx.AsyncClient, url: str) -> GeneratedImage:
    try:
        safe_url = await asyncio.to_thread(validate_public_https_url, url)
    except ValueError as error:
        raise ImageProviderError(f"生图结果地址不安全: {error}") from error
    resp = await client.get(safe_url)
    if resp.status_code >= 400:
        raise ImageProviderError(f"下载生图结果失败 (HTTP {resp.status_code})")
    return _parse_image_bytes(resp.content)


def _ratio_dimensions(aspect_ratio: str, fallback_w: int, fallback_h: int) -> tuple[int, int]:
    mapping = {
        "1:1": (1024, 1024),
        "3:4": (896, 1152),
        "4:3": (1152, 896),
        "2:3": (832, 1248),
        "3:2": (1248, 832),
        "16:9": (1280, 720),
        "9:16": (720, 1280),
        "21:9": (1344, 576),
        "9:21": (576, 1344),
    }
    return mapping.get(aspect_ratio, (fallback_w, fallback_h))


def _openai_size(aspect_ratio: str, width: int, height: int) -> str:
    if aspect_ratio in {"3:4", "2:3", "9:16", "9:21"}:
        return "1024x1536"
    if aspect_ratio in {"4:3", "3:2", "16:9", "21:9"}:
        return "1536x1024"
    if aspect_ratio == "1:1":
        return "1024x1024"
    if width == height:
        return "1024x1024"
    return "1536x1024" if width > height else "1024x1536"


class ConfiguredImageProvider:
    """BYOK image generation & editing adapter (OpenAI, DashScope, SiliconFlow)."""

    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str,
        default_model: str,
    ) -> None:
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.default_model = default_model

    async def test_connection(self) -> None:
        safe_url = await asyncio.to_thread(validate_public_https_url, self.base_url)
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            if self.provider == "dashscope":
                endpoint = (
                    safe_url
                    if safe_url.endswith("/generation")
                    else f"{safe_url}/services/aigc/multimodal-generation/generation"
                )
                # Minimal auth probe without triggering billable generation.
                resp = await client.post(
                    endpoint,
                    headers=headers,
                    json={"model": self.default_model, "input": {"messages": []}},
                )
                if resp.status_code in {401, 403}:
                    raise ImageProviderError("DashScope API Key 鉴权失败，请检查密钥")
                if resp.status_code >= 500 or resp.status_code == 404:
                    raise ImageProviderError(f"DashScope 接口地址不可达 (HTTP {resp.status_code})")
                return
            resp = await client.get(f"{safe_url}/models", headers=headers)
            if resp.status_code in {401, 403}:
                raise ImageProviderError("生图服务 API Key 鉴权失败，请检查密钥")
            if resp.status_code >= 400 and resp.status_code != 405:
                raise ImageProviderError(f"无法连接生图服务 (HTTP {resp.status_code})")

    async def generate(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        if request.reference_images:
            return await self.edit(request)
        return await self._dispatch(request)

    async def edit(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        return await self._dispatch(request)

    async def _dispatch(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        safe_url = await asyncio.to_thread(validate_public_https_url, self.base_url)
        model = self.default_model if request.model in {"", "auto"} else request.model
        async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
            if self.provider == "dashscope":
                return await self._call_dashscope(client, safe_url, model, request)
            if self.provider == "siliconflow":
                return await self._call_siliconflow(client, safe_url, model, request)
            return await self._call_openai(client, safe_url, model, request)

    async def _collect_b64_or_urls(
        self, client: httpx.AsyncClient, items: list[dict], limit: int
    ) -> list[GeneratedImage]:
        results: list[GeneratedImage] = []
        for entry in items[:limit]:
            if entry.get("b64_json"):
                raw = base64.b64decode(entry["b64_json"])
                results.append(_parse_image_bytes(raw))
            elif entry.get("url"):
                results.append(await _fetch_image_url(client, str(entry["url"])))
        if not results:
            raise ImageProviderError("生图服务未返回任何可用图片数据")
        return results

    async def _call_openai(
        self,
        client: httpx.AsyncClient,
        safe_url: str,
        model: str,
        request: ImageGenerationRequest,
    ) -> list[GeneratedImage]:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        refs = request.reference_images
        size = _openai_size(request.aspect_ratio, request.width, request.height)
        is_gpt_image = model.startswith("gpt-image") or model.startswith("chatgpt-image")

        if refs:
            if len(refs) > 16:
                raise ImageProviderError("OpenAI /images/edits 单次最多支持 16 张参考图")
            files = []
            field_name = "image" if len(refs) == 1 else "image[]"
            for idx, ref in enumerate(refs):
                ext = _EXT_BY_MIME.get(ref.mime_type, "png")
                files.append((field_name, (f"ref_{idx}.{ext}", ref.content, ref.mime_type)))
            data: dict[str, str] = {
                "model": model,
                "prompt": request.prompt,
                "n": str(request.count),
            }
            if size:
                data["size"] = size
            if request.quality != "auto":
                data["quality"] = request.quality
            if is_gpt_image and request.input_fidelity in {"high", "low"}:
                data["input_fidelity"] = request.input_fidelity
            if is_gpt_image and request.transparent:
                data["background"] = "transparent"
                data["output_format"] = "png"
            resp = await client.post(
                f"{safe_url}/images/edits", headers=headers, data=data, files=files
            )
        else:
            payload: dict[str, object] = {
                "model": model,
                "prompt": request.prompt,
                "n": request.count,
                "size": size,
            }
            if request.quality != "auto":
                payload["quality"] = request.quality
            if is_gpt_image and request.transparent:
                payload["background"] = "transparent"
                payload["output_format"] = "png"
            resp = await client.post(
                f"{safe_url}/images/generations", headers=headers, json=payload
            )

        if resp.status_code >= 400:
            raise ImageProviderError(f"OpenAI 生图接口错误 (HTTP {resp.status_code})")
        body = resp.json()
        return await self._collect_b64_or_urls(client, body.get("data") or [], request.count)

    async def _call_dashscope(
        self,
        client: httpx.AsyncClient,
        safe_url: str,
        model: str,
        request: ImageGenerationRequest,
    ) -> list[GeneratedImage]:
        refs = request.reference_images
        if len(refs) > 3:
            raise ImageProviderError("阿里百炼 qwen-image-2.0 单次最多支持 3 张参考图")

        endpoint = (
            safe_url
            if safe_url.endswith("/generation")
            else f"{safe_url}/services/aigc/multimodal-generation/generation"
        )
        content: list[dict[str, str]] = []
        for ref in refs:
            b64 = base64.b64encode(ref.content).decode("ascii")
            content.append({"image": f"data:{ref.mime_type};base64,{b64}"})
        content.append({"text": request.prompt})

        params: dict[str, object] = {
            "n": min(max(request.count, 1), 6),
            "watermark": False,
            "prompt_extend": True,
        }
        # Only specify size when pure text-to-image OR user selected explicit aspect ratio.
        if not refs or request.aspect_ratio != "auto":
            w, h = _ratio_dimensions(request.aspect_ratio, request.width, request.height)
            params["size"] = f"{w}*{h}"

        payload = {
            "model": model,
            "input": {"messages": [{"role": "user", "content": content}]},
            "parameters": params,
        }
        resp = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        if resp.status_code >= 400:
            raise ImageProviderError(f"百炼生图接口错误 (HTTP {resp.status_code})")
        body = resp.json()
        choices = (body.get("output") or {}).get("choices") or []
        image_entries: list[dict] = []
        for choice in choices:
            parts = ((choice.get("message") or {}).get("content")) or []
            for part in parts:
                if isinstance(part, dict) and part.get("image"):
                    image_entries.append({"url": part["image"]})
        return await self._collect_b64_or_urls(client, image_entries, request.count)

    async def _call_siliconflow(
        self,
        client: httpx.AsyncClient,
        safe_url: str,
        model: str,
        request: ImageGenerationRequest,
    ) -> list[GeneratedImage]:
        refs = request.reference_images
        if len(refs) > 1:
            raise ImageProviderError("硅基流动生图接口当前最多支持 1 张参考图")

        w, h = _ratio_dimensions(request.aspect_ratio, request.width, request.height)
        payload: dict[str, object] = {
            "model": model,
            "prompt": request.prompt,
            "image_size": f"{w}x{h}",
            "batch_size": min(max(request.count, 1), 4),
        }
        if len(refs) == 1:
            ref = refs[0]
            b64 = base64.b64encode(ref.content).decode("ascii")
            payload["image"] = f"data:{ref.mime_type};base64,{b64}"

        resp = await client.post(
            f"{safe_url}/images/generations",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        if resp.status_code >= 400:
            raise ImageProviderError(f"硅基流动生图接口错误 (HTTP {resp.status_code})")
        body = resp.json()
        entries = body.get("images") or body.get("data") or []
        return await self._collect_b64_or_urls(client, entries, request.count)
