from __future__ import annotations

import base64
import io
import json
import uuid

import httpx
import pytest
from PIL import Image

from canvas_api.providers.images import (
    ConfiguredImageProvider,
    ImageGenerationRequest,
    ImageProviderError,
    ReferenceImage,
)


def _sample_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (24, 24), "#c9b39c").save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_dashscope_qwen_image_preserves_order_and_auto_ratio(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sample = _sample_png()

    class MockClient:
        def __init__(self, **kwargs):
            del kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers=None, json=None, **kwargs):
            del headers, kwargs
            captured["post_url"] = url
            captured["payload"] = json
            return httpx.Response(
                200,
                json={
                    "output": {
                        "choices": [
                            {
                                "message": {
                                    "content": [{"image": "https://dashscope.aliyuncs.com/out.png"}]
                                }
                            }
                        ]
                    }
                },
            )

        async def get(self, url, **kwargs):
            del kwargs
            captured["get_url"] = url
            return httpx.Response(200, content=sample)

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda url: url.rstrip("/"),
    )

    provider = ConfiguredImageProvider(
        provider="dashscope",
        base_url="https://dashscope.aliyuncs.com/api/v1",
        api_key="sk-test-key",
        default_model="qwen-image-2.0",
    )
    refs = (
        ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
        ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
    )
    req = ImageGenerationRequest(
        user_id=uuid.uuid4(),
        prompt="把图1放入图2走廊",
        model="auto",
        reference_asset_ids=tuple(r.asset_id for r in refs),
        quality="auto",
        width=1024,
        height=1024,
        align_to_16=True,
        resolution="auto",
        aspect_ratio="auto",
        transparent=False,
        count=1,
        reference_images=refs,
    )
    out = await provider.generate(req)
    assert len(out) == 1
    assert captured["post_url"].endswith("/services/aigc/multimodal-generation/generation")
    parts = captured["payload"]["input"]["messages"][0]["content"]
    assert len(parts) == 3  # 图1, 图2, text
    assert "size" not in captured["payload"]["parameters"]  # preserves last input image ratio


@pytest.mark.asyncio
async def test_siliconflow_rejects_multiple_refs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda url: url.rstrip("/"),
    )
    sample = _sample_png()
    provider = ConfiguredImageProvider(
        provider="siliconflow",
        base_url="https://api.siliconflow.cn/v1",
        api_key="sk-sf-test",
        default_model="Kwai-Kolors/Kolors",
    )
    req = ImageGenerationRequest(
        user_id=uuid.uuid4(),
        prompt="融合",
        model="auto",
        reference_asset_ids=(uuid.uuid4(), uuid.uuid4()),
        quality="auto",
        width=1024,
        height=1024,
        align_to_16=True,
        resolution="auto",
        aspect_ratio="1:1",
        transparent=False,
        count=1,
        reference_images=(
            ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
            ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
        ),
    )
    with pytest.raises(ImageProviderError, match="1 张参考图"):
        await provider.generate(req)


@pytest.mark.asyncio
async def test_openai_edit_sends_multipart_and_transparent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sample = _sample_png()
    b64_sample = base64.b64encode(sample).decode("ascii")

    class MockClient:
        def __init__(self, **kwargs):
            del kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers=None, data=None, files=None, json=None, **kwargs):
            del headers, json, kwargs
            captured["url"] = url
            captured["data"] = data
            captured["files"] = files
            return httpx.Response(200, json={"data": [{"b64_json": b64_sample}]})

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda url: url.rstrip("/"),
    )

    provider = ConfiguredImageProvider(
        provider="openai-compatible",
        base_url="https://api.openai.com/v1",
        api_key="sk-oai-test",
        default_model="gpt-image-1",
    )
    req = ImageGenerationRequest(
        user_id=uuid.uuid4(),
        prompt="抠图去背景",
        model="gpt-image-1",
        reference_asset_ids=(uuid.uuid4(),),
        quality="high",
        width=1024,
        height=1024,
        align_to_16=True,
        resolution="auto",
        aspect_ratio="1:1",
        transparent=True,
        count=1,
        reference_images=(
            ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
        ),
        input_fidelity="high",
    )
    out = await provider.generate(req)
    assert len(out) == 1
    assert captured["url"].endswith("/images/edits")
    assert captured["data"]["background"] == "transparent"
    assert captured["data"]["input_fidelity"] == "high"
    assert captured["files"][0][0] == "image"
    assert json.dumps(captured["data"])


@pytest.mark.asyncio
async def test_google_gemini_nano_banana_inline_refs_and_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sample = _sample_png()
    b64_sample = base64.b64encode(sample).decode("ascii")

    class MockClient:
        def __init__(self, **kwargs):
            del kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers=None, json=None, **kwargs):
            del kwargs
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return httpx.Response(
                200,
                json={
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {"inlineData": {"mimeType": "image/png", "data": b64_sample}}
                                ]
                            }
                        }
                    ]
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda url: url.rstrip("/"),
    )

    provider = ConfiguredImageProvider(
        provider="google-gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        api_key="AIza-test-gemini-key",
        default_model="gemini-nano-banana-2.1",
    )
    refs = (
        ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
        ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
    )
    req = ImageGenerationRequest(
        user_id=uuid.uuid4(),
        prompt="融合两位主角到暖光客厅",
        model="gemini-nano-banana-2.1",
        reference_asset_ids=tuple(r.asset_id for r in refs),
        quality="auto",
        width=1024,
        height=1024,
        align_to_16=True,
        resolution="2K",
        aspect_ratio="16:9",
        transparent=False,
        count=1,
        reference_images=refs,
    )
    out = await provider.generate(req)
    assert len(out) == 1
    assert captured["url"].endswith("/models/gemini-nano-banana-2.1:generateContent")
    assert captured["headers"]["x-goog-api-key"] == "AIza-test-gemini-key"
    parts = captured["json"]["contents"][0]["parts"]
    assert len(parts) == 3
    img_cfg = captured["json"]["generationConfig"]["imageConfig"]
    assert img_cfg == {"aspectRatio": "16:9", "imageSize": "2K"}


@pytest.mark.asyncio
async def test_openai_gpt_image_2_5_edit_omits_input_fidelity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sample = _sample_png()
    b64_sample = base64.b64encode(sample).decode("ascii")

    class MockClient:
        def __init__(self, **kwargs):
            del kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers=None, json=None, **kwargs):
            del headers, kwargs
            captured["url"] = url
            captured["json"] = json
            return httpx.Response(200, json={"data": [{"b64_json": b64_sample}]})

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda url: url.rstrip("/"),
    )

    provider = ConfiguredImageProvider(
        provider="openai-compatible",
        base_url="https://api.openai.com/v1",
        api_key="sk-oai-25-test",
        default_model="gpt-image-2.5-sunburst",
    )
    req = ImageGenerationRequest(
        user_id=uuid.uuid4(),
        prompt="替换为米白背景",
        model="gpt-image-2.5-sunburst",
        reference_asset_ids=(uuid.uuid4(),),
        quality="high",
        width=1024,
        height=1024,
        align_to_16=True,
        resolution="auto",
        aspect_ratio="3:4",
        transparent=True,
        count=1,
        reference_images=(
            ReferenceImage(asset_id=uuid.uuid4(), mime_type="image/png", content=sample),
        ),
        input_fidelity="high",
    )
    out = await provider.generate(req)
    assert len(out) == 1
    assert captured["url"].endswith("/images/edits")
    assert "input_fidelity" not in captured["json"]
    assert captured["json"]["images"][0]["image_url"].startswith("data:image/png;base64,")
    assert captured["json"]["background"] == "transparent"


@pytest.mark.asyncio
async def test_openai_aggregator_routes_nano_banana_via_chat_completions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sample = _sample_png()
    b64_sample = base64.b64encode(sample).decode("ascii")

    class MockClient:
        def __init__(self, **kwargs):
            del kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers=None, json=None, **kwargs):
            del headers, kwargs
            captured["url"] = url
            captured["json"] = json
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "images": [
                                    {"image_url": {"url": f"data:image/png;base64,{b64_sample}"}}
                                ],
                            }
                        }
                    ]
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda url: url.rstrip("/"),
    )

    provider = ConfiguredImageProvider(
        provider="openai-compatible",
        base_url="https://openrouter.ai/api/v1",
        api_key="sk-or-test",
        default_model="google/gemini-2.5-flash-image",
    )
    req = ImageGenerationRequest(
        user_id=uuid.uuid4(),
        prompt="Editorial ceramic vase",
        model="google/gemini-2.5-flash-image",
        reference_asset_ids=(),
        quality="auto",
        width=1024,
        height=1024,
        align_to_16=True,
        resolution="auto",
        aspect_ratio="3:4",
        transparent=False,
        count=1,
    )
    out = await provider.generate(req)
    assert len(out) == 1
    assert captured["url"].endswith("/chat/completions")
    assert captured["json"]["modalities"] == ["image", "text"]


@pytest.mark.asyncio
async def test_volcengine_ark_seedream_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}
    sample = _sample_png()
    b64_sample = base64.b64encode(sample).decode("ascii")

    class MockClient:
        def __init__(self, **kwargs):
            del kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers=None, json=None, **kwargs):
            del headers, kwargs
            captured["url"] = url
            captured["json"] = json
            return httpx.Response(200, json={"data": [{"b64_json": b64_sample}]})

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda url: url.rstrip("/"),
    )

    provider = ConfiguredImageProvider(
        provider="volcengine-ark",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        api_key="ark-key-test",
        default_model="doubao-seedream-4-0-250828",
    )
    req = ImageGenerationRequest(
        user_id=uuid.uuid4(),
        prompt="极简建筑光影",
        model="doubao-seedream-4-0-250828",
        reference_asset_ids=(),
        quality="auto",
        width=1024,
        height=1024,
        align_to_16=True,
        resolution="2K",
        aspect_ratio="3:4",
        transparent=False,
        count=1,
    )
    out = await provider.generate(req)
    assert len(out) == 1
    assert captured["url"].endswith("/images/generations")
    assert captured["json"]["size"] == "2K"
    assert captured["json"]["watermark"] is False
