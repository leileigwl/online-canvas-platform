from __future__ import annotations

import base64
import io
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from PIL import Image

from canvas_api.config import Settings
from canvas_api.main import create_app
from canvas_api.providers.images import GeneratedImage, ImageGenerationRequest
from canvas_api.tools import PlanValidationError, apply_canvas_operation, validate_plan


def _make_png_bytes(width: int = 32, height: int = 32, color: str = "#d9c8b4") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


class _FakeImageProvider:
    def __init__(self) -> None:
        self.requests: list[ImageGenerationRequest] = []

    async def generate(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        self.requests.append(request)
        png = _make_png_bytes(64, 64)
        return [GeneratedImage(content=png, mime_type="image/png", width=64, height=64)]

    async def edit(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        return await self.generate(request)


async def _make_test_app(tmp_path: Path) -> tuple[FastAPI, _FakeImageProvider]:
    settings = Settings(
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'test.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
    )
    app = create_app(settings)
    fake = _FakeImageProvider()
    return app, fake


@pytest.mark.asyncio
async def test_register_starter_canvas_versions_and_image_config(tmp_path: Path) -> None:
    app, fake = await _make_test_app(tmp_path)
    async with app.router.lifespan_context(app):
        app.state.image_provider = fake
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Register creates starter project + canvas with welcome note
            res = await client.post(
                "/api/auth/register", json={"username": "creator_one", "password": "password123"}
            )
            assert res.status_code == 201
            projects = (await client.get("/api/projects")).json()
            assert len(projects) == 1
            canvases = (await client.get(f"/api/projects/{projects[0]['id']}/canvases")).json()
            assert canvases[0]["name"] == "我的第一个灵感画布"
            canvas_id = canvases[0]["id"]
            assert canvases[0]["document"]["items"][0]["id"] == "starter-welcome-note"

            # 2. Save document containing text + brush items, verify deduplicated versions
            doc_v1 = {
                "schema_version": 1,
                "items": [
                    {
                        "id": "txt-1",
                        "type": "text",
                        "x": 10,
                        "y": 20,
                        "width": 200,
                        "height": 48,
                        "title": "标题",
                        "content": "Editorial Note",
                        "font_family": "serif",
                        "font_size": 24,
                        "color": "#141413",
                        "visible": True,
                    },
                    {
                        "id": "brush-1",
                        "type": "brush",
                        "x": 50,
                        "y": 90,
                        "width": 120,
                        "height": 40,
                        "title": "涂鸦",
                        "points": [0, 0, 40, 20, 90, 10],
                        "stroke_width": 4,
                        "color": "#2563eb",
                        "visible": True,
                    },
                ],
            }
            save_res = await client.put(
                f"/api/canvases/{canvas_id}",
                json={
                    "base_revision": 0,
                    "document": doc_v1,
                    "viewport": {"x": 0, "y": 0, "scale": 1},
                },
            )
            assert save_res.status_code == 200
            assert save_res.json()["revision"] == 1

            # Restore back to revision 0 and confirm items reverted
            rest_res = await client.post(
                f"/api/canvases/{canvas_id}/restore",
                json={"base_revision": 1, "version_revision": 0},
            )
            assert rest_res.status_code == 200
            assert rest_res.json()["revision"] == 2
            assert rest_res.json()["document"]["items"][0]["id"] == "starter-welcome-note"

            # 3. BYOK Image Config rejects unsafe local HTTP URLs and never echoes key
            bad_cfg = await client.put(
                "/api/agent/image-config",
                json={
                    "provider": "dashscope",
                    "base_url": "http://127.0.0.1:8080/v1",
                    "model_name": "qwen-image-2.0",
                    "api_key": "sk-secret-key-value",
                },
            )
            assert bad_cfg.status_code == 422

            good_cfg = await client.put(
                "/api/agent/image-config",
                json={
                    "provider": "dashscope",
                    "base_url": "https://dashscope.aliyuncs.com/api/v1",
                    "model_name": "qwen-image-2.0",
                    "api_key": "sk-dashscope-secret-9999",
                },
            )
            assert good_cfg.status_code == 200
            cfg_body = good_cfg.json()
            assert cfg_body["configured"] is True
            assert "sk-dashscope-secret-9999" not in str(cfg_body)


@pytest.mark.asyncio
async def test_generation_and_cross_user_isolation(tmp_path: Path) -> None:
    app, fake = await _make_test_app(tmp_path)
    async with app.router.lifespan_context(app):
        app.state.image_provider = fake
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.post(
                "/api/auth/register", json={"username": "user_alpha", "password": "password123"}
            )
            png = _make_png_bytes(48, 48)
            up = await client.post("/api/assets", files={"file": ("ref.png", png, "image/png")})
            assert up.status_code == 201
            asset_id = up.json()["id"]

            gen = await client.post(
                "/api/generations",
                json={
                    "prompt": "陶土静物摄影",
                    "reference_asset_ids": [asset_id],
                    "aspect_ratio": "3:4",
                    "count": 1,
                },
            )
            assert gen.status_code == 200
            assert len(gen.json()["images"]) == 1
            assert fake.requests[0].reference_images[0].asset_id == uuid.UUID(asset_id)

            # Second user must not read first user's asset
            async with AsyncClient(transport=transport, base_url="http://test") as other:
                await other.post(
                    "/api/auth/register", json={"username": "user_beta", "password": "password123"}
                )
                deny = await other.get(f"/api/assets/{asset_id}/content")
                assert deny.status_code == 404


def test_validate_plan_and_local_align() -> None:
    items = [
        {
            "id": "img1",
            "type": "image",
            "x": 100,
            "y": 100,
            "width": 200,
            "height": 200,
            "asset_id": str(uuid.uuid4()),
        },
        {
            "id": "img2",
            "type": "image",
            "x": 500,
            "y": 400,
            "width": 160,
            "height": 180,
            "asset_id": str(uuid.uuid4()),
        },
        {"id": "note1", "type": "note", "x": 850, "y": 720, "width": 240, "height": 120},
    ]

    with pytest.raises(PlanValidationError):
        validate_plan([{"tool": "run_shell", "params": {"cmd": "rm -rf"}}], items)

    with pytest.raises(PlanValidationError):
        validate_plan(
            [
                {
                    "tool": "edit_image",
                    "params": {
                        "prompt": "融合",
                        "reference_object_ids": ["img1"],
                        "asset_id": "forged",
                    },
                }
            ],
            items,
        )

    ops = validate_plan(
        [
            {
                "tool": "align_objects",
                "params": {"object_ids": ["img1", "img2"], "columns": 2, "gap": 24},
            },
            {"tool": "add_text", "params": {"content": "标题文字", "x": 100, "y": 40}},
        ],
        items,
    )
    for op in ops:
        apply_canvas_operation(items, op, new_id=f"new-{uuid.uuid4()}")

    # Unselected note1 must remain untouched at (850, 720)
    note1 = next(it for it in items if it["id"] == "note1")
    assert (note1["x"], note1["y"]) == (850, 720)
    # Selected img2 aligned beside img1 (min_x=100, max_w=200 + gap=24 => x=324, y=100)
    img2 = next(it for it in items if it["id"] == "img2")
    assert (img2["x"], img2["y"]) == (324, 100)
    assert any(it["type"] == "text" and it["content"] == "标题文字" for it in items)
    # Confirm b64 encoding helper dependency works cleanly
    assert base64.b64encode(b"ok") == b"b2s="
