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
