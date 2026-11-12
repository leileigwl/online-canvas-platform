from __future__ import annotations

import uuid
from pathlib import Path

import httpx
import pytest
from canvas_api.config import Settings
from canvas_api.main import create_app
from canvas_api.models import (
    AgentRun,
    AgentTask,
    Asset,
    Canvas,
    CanvasMemory,
    Project,
    RunStatus,
    User,
)
from canvas_api.providers.images import ImageGenerationRequest, MockImageProvider
from canvas_api.security import hash_password, reset_rate_limits
from canvas_api.storage import create_storage
from canvas_api.tools import verify_proposal_layout
from PIL import Image
from sqlalchemy import select

from canvas_worker.main import execute_agent_run


@pytest.fixture(autouse=True)
def _reset_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.mark.asyncio
async def test_mock_image_provider_and_settings_endpoints(tmp_path: Path) -> None:
    provider = MockImageProvider(default_model="mock-studio-v1", latency_ms=0)
    generated = await provider.generate(
        ImageGenerationRequest(
            user_id=uuid.uuid4(),
            prompt="暖象牙极简香氛静物摄影",
            model="mock-studio-v1",
            reference_asset_ids=(),
            quality="auto",
            width=896,
            height=1152,
            align_to_16=True,
            resolution="auto",
            aspect_ratio="3:4",
            transparent=False,
            count=2,
        )
    )
    assert len(generated) == 2
    assert generated[0].mime_type == "image/png"
    assert generated[0].width < generated[0].height

    settings = Settings(
        _env_file=None,
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'mock_cfg.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as db:
            db.add(User(username="mock_tester", password_hash=hash_password("password123")))
            await db.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert (
                await client.post(
                    "/api/auth/login",
                    json={"identifier": "mock_tester", "password": "password123"},
                )
            ).status_code == 200

            # Test & save mock provider with NO external API key
            test_res = await client.post(
                "/api/agent/image-config/test",
                json={
                    "provider": "mock",
                    "base_url": "https://mock.flowcanvas.local/v1",
                    "model_name": "mock-studio-v1",
                },
            )
            assert test_res.status_code == 200 and test_res.json()["ok"] is True

            save_res = await client.post(
                "/api/agent/image-configs",
                json={
                    "label": "Mock Studio 默认",
                    "provider": "mock",
                    "base_url": "https://mock.flowcanvas.local/v1",
                    "model_name": "mock-studio-v1",
                    "is_default": True,
                },
            )
            assert save_res.status_code == 201
            assert save_res.json()["provider"] == "mock"

            # Direct generation routes cleanly to MockImageProvider
            gen_res = await client.post(
                "/api/generations",
                json={"prompt": "极简陶艺花瓶", "aspect_ratio": "16:9", "count": 1},
            )
            assert gen_res.status_code == 200
            img_info = gen_res.json()["images"][0]
            assert img_info["width"] > img_info["height"]


def test_verify_proposal_layout_detects_overlap_and_passes_clean_grid() -> None:
    overlapping = verify_proposal_layout(
        [],
        [
            {
                "tool": "generate_image",
                "params": {"prompt": "a", "x": 0, "y": 0, "width": 240, "height": 240},
            },
            {
                "tool": "add_note",
                "params": {
                    "title": "b",
                    "content": "x",
                    "x": 30,
                    "y": 20,
                    "width": 240,
                    "height": 140,
                },
            },
        ],
    )
    assert overlapping["passed"] is False
    assert overlapping["issues"][0]["code"] == "overlap"

    spaced = verify_proposal_layout(
        [],
        [
            {
                "tool": "generate_image",
                "params": {"prompt": "a", "x": 0, "y": 0, "width": 240, "height": 240},
            },
            {
                "tool": "add_note",
                "params": {
                    "title": "b",
                    "content": "x",
                    "x": 280,
                    "y": 0,
                    "width": 240,
                    "height": 140,
                },
            },
        ],
    )
    assert spaced["passed"] is True
    assert spaced["issue_count"] == 0


@pytest.mark.asyncio
async def test_closed_loop_collision_self_repair_and_harness_compaction(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'harness_loop.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
        max_agent_model_calls_per_run=18,
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as db:
            user = User(username="harness_user", password_hash=hash_password("password123"))
            db.add(user)
            await db.flush()
            project = Project(owner_id=user.id, name="Harness Lab")
            db.add(project)
            await db.flush()
            canvas = Canvas(
                project_id=project.id,
                name="闭环验证画布",
                document={"schema_version": 1, "items": []},
                viewport={"x": 0, "y": 0, "scale": 1},
                schema_version=1,
                revision=0,
            )
            db.add(canvas)
            await db.flush()

            # Run 1: Scripted collision -> Verifier rejects -> Reviewer loops back -> Round 2 fixes
            run1 = AgentRun(
                owner_id=user.id,
                project_id=project.id,
                canvas_id=canvas.id,
                goal="生成极简陶瓷静物并配右侧注释卡",
                reference_asset_ids=[],
                harness_options={
                    "llm_mode": "scripted",
                    "use_mock_image": True,
                    "lab_scenario": "collision_repair",
                    "max_repair_rounds": 2,
                },
                context_revision=0,
                model_call_budget=18,
                completion_tokens_per_call=2048,
                status=RunStatus.QUEUED,
            )
            db.add(run1)
            await db.flush()
            db.add(
                AgentTask(
                    run_id=run1.id,
                    role="Coordinator",
                    sequence=0,
                    task_key="coordinator",
                    title="拆解创作目标",
                    depends_on=[],
                    status=RunStatus.QUEUED,
                )
            )
            await db.commit()
            run1_id = str(run1.id)
            canvas_id = canvas.id
            user_id = user.id

        ctx = {
            "settings": settings,
            "session_factory": app.state.session_factory,
            "object_storage": create_storage(settings),
        }
        await execute_agent_run(ctx, run1_id)

        async with app.state.session_factory() as db:
            finished = await db.get(AgentRun, uuid.UUID(run1_id))
            assert finished is not None
            assert finished.status == RunStatus.SUCCEEDED
            prop = finished.proposal or {}
            # Must have looped 2 rounds: round 1 rejected on overlap, round 2 fixed and approved
            assert prop["attempt_count"] == 2
            assert len(prop["repair_history"]) == 2
            assert prop["repair_history"][0]["verifier_passed"] is False
            assert prop["repair_history"][0]["approved"] is False
            assert prop["repair_history"][1]["verifier_passed"] is True
            assert prop["repair_history"][1]["approved"] is True
            assert prop["verifier"]["passed"] is True

            # Only 1 mock Asset persisted (reused across repair loop instead of duplicating!)
            assets = list(await db.scalars(select(Asset).where(Asset.owner_id == user_id)))
            assert len(assets) == 1
            with Image.open(tmp_path / "assets" / assets[0].object_key) as im:
                assert im.format == "PNG"

        # Verify Harness Inspect & Manual Compaction endpoints
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert (
                await client.post(
                    "/api/auth/login",
                    json={"identifier": "harness_user", "password": "password123"},
                )
            ).status_code == 200

            insp = await client.post(
                f"/api/canvases/{canvas_id}/harness/inspect",
                json={"operations": []},
            )
            assert insp.status_code == 200
            assert insp.json()["memory"]["recent_run_count"] == 1

            compacted = await client.post(
                f"/api/canvases/{canvas_id}/memory/compact",
                json={"llm_mode": "scripted"},
            )
            assert compacted.status_code == 200
            assert compacted.json()["compacted_run_count"] == 1
            assert "生成极简陶瓷静物" in compacted.json()["compacted_summary"]

            async with app.state.session_factory() as db:
                mem = await db.scalar(
                    select(CanvasMemory).where(CanvasMemory.canvas_id == canvas_id)
                )
                assert mem is not None and mem.compacted_run_count == 1
